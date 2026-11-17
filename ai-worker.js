/**
 * Speakwise AI tutor API (Cloudflare Workers).
 * Optional secret: GEMINI_API_KEY. Workers AI binding is the regional fallback.
 * AI estimates only. Never use API keys client-side.
 */
const headers=(origin)=>({'content-type':'application/json; charset=utf-8','access-control-allow-origin':origin,'access-control-allow-headers':'content-type','access-control-allow-methods':'POST, OPTIONS','cache-control':'no-store','vary':'Origin','x-content-type-options':'nosniff'});
const reply=(value,status,origin)=>new Response(JSON.stringify(value),{status,headers:headers(origin)});
const limit=(x,n=1400)=>String(x||'').slice(0,n);
const describeAIError=err=>{
 const parts=[];
 if(err?.message)parts.push(err.message);
 if(err?.cause?.message)parts.push('cause: '+err.cause.message);
 if(Array.isArray(err?.errors))for(const item of err.errors.slice(0,3))parts.push([item?.code,item?.message].filter(Boolean).join(': '));
 if(!parts.length&&typeof err==='string')parts.push(err);
 return limit(parts.join(' | ')||'Unknown Workers AI error',260);
};
const score=x=>Number.isFinite(Number(x))?Math.max(0,Math.min(100,Math.round(Number(x)))):null;
const isGeminiLocationError=(status,message)=>status===400&&/FAILED_PRECONDITION|user location is not supported|location (is )?not supported|unsupported location/i.test(String(message||''));
const WORKERS_AI_TEXT_MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const workersAiJson=async(env,prompt,maxTokens=1800)=>{
 if(!env.AI||typeof env.AI.run!=='function')throw new Error('Thiếu Workers AI binding (AI).');
 const result=await env.AI.run(WORKERS_AI_TEXT_MODEL,{
  messages:[
   {role:'system',content:'You are a precise English-learning tutor. Return only a valid JSON object matching the requested structure. Do not add markdown.'},
   {role:'user',content:prompt}
  ],
  response_format:{type:'json_object'},
  max_tokens:maxTokens,
  temperature:0.2
 });
 if(result?.success===false||Array.isArray(result?.errors)&&result.errors.length){
  throw new Error('Cloudflare Workers AI: '+describeAIError(result));
 }
 const raw=typeof result==='string'?result:(typeof result?.response==='string'?result.response:result?.output_text||result?.text||'');
 if(!raw)throw new Error('Workers AI không trả về nội dung JSON. '+describeAIError(result));
 const clean=String(raw).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try{return JSON.parse(clean)}catch(parseError){throw new Error('Workers AI trả về JSON không hợp lệ: '+describeAIError(parseError))}
};
const workersAiTranscribe=async(env,audioBase64)=>{
 if(!env.AI||typeof env.AI.run!=='function')throw new Error('Thiếu Workers AI binding (AI).');
 const result=await env.AI.run('@cf/openai/whisper-large-v3-turbo',{
  audio:audioBase64,task:'transcribe',language:'en'
 });
 const transcript=String(result?.text||result?.transcription||'').trim();
 if(!transcript)throw new Error('Whisper không tạo được bản chép lời.');
 return transcript;
};
export default {
 async fetch(req,env) {
  const url=new URL(req.url),path=url.pathname;
  if(path!=='/evaluate'&&path!=='/health'&&path!=='/generate'&&path!=='/hint'){return env.ASSETS?.fetch(req)||new Response('Not found',{status:404})}
  const allowed=String(env.ALLOWED_ORIGIN||url.origin).replace(/\/$/,'');
  const incoming=req.headers.get('origin');
  if(incoming&&incoming!==allowed)return new Response('Origin not allowed',{status:403});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(allowed)});
  if(path==='/health'&&req.method==='GET')return reply({ok:true,aiReady:!!env.GEMINI_API_KEY||!!env.AI?.run,providers:{gemini:!!env.GEMINI_API_KEY,workersAI:!!env.AI?.run},model:env.GEMINI_MODEL||'gemini-3.5-flash-lite',fallbackModel:env.GEMINI_FALLBACK_MODEL||'gemini-3.8-flash',workersAIModel:WORKERS_AI_TEXT_MODEL},200,allowed);
  if(!['/evaluate','/generate','/hint'].includes(path)||req.method!=='POST')return reply({error:'Method not allowed'},405,allowed);
  if(!env.GEMINI_API_KEY&&!env.AI?.run)return reply({error:'AI chưa được cấu hình: cần GEMINI_API_KEY hoặc Workers AI binding.'},503,allowed);
  try{
   if(Number(req.headers.get('content-length')||0)>9e6)return reply({error:'Ghi âm quá lớn.'},413,allowed);
   const raw=await req.text();
   if(raw.length>9e6)return reply({error:'Yêu cầu quá lớn.'},413,allowed);
   let b;try{b=JSON.parse(raw)}catch{return reply({error:'JSON không hợp lệ.'},400,allowed)}

   if(path==='/hint'){
     const phrase=limit(b.phrase,180).trim(),meaning=limit(b.meaning,240).trim();
     const topic=limit(b.topic,100).trim(),example=limit(b.example,500).trim();
     if(phrase.length<3||!meaning||!phrase.includes(' '))
       return reply({error:'Thiếu collocation hoặc nghĩa để tạo gợi ý.'},400,allowed);
     const prompt='You are a thoughtful English speaking and writing tutor. Help a learner generate their OWN idea for one sentence using the target collocation. '+
       'Target: '+JSON.stringify({collocation:phrase,meaning,topic,referenceExample:example})+'. '+
       'Return exactly 3 DISTINCT, realistic, easy-to-personalise contexts. Each context must be a short situation in Vietnamese, '+
       '3 to 6 concise English keywords or short phrases (not full sentences), and one guiding question in Vietnamese that helps the learner recall a real experience or form a specific idea. '+
       'The hints must fit the collocation meaning and show natural situations where it can be used. '+
       'Do NOT write a complete sample sentence, do NOT write the learner answer, and do NOT merely repeat the reference example. '+
       'Avoid generic prompts. Prefer varied everyday, study, work, travel or personal contexts when relevant. '+
       'Return ONLY JSON: {hints:[{situation:string,keywords:string[],guidingQuestion:string}]} with exactly 3 items. Vietnamese for situation and guidingQuestion; English for keywords.';
     const models=[...new Set([env.GEMINI_MODEL||'gemini-3.5-flash-lite',env.GEMINI_FALLBACK_MODEL||'gemini-3.8-flash'])].slice(0,2);
     const started=Date.now(),attempts=[];let parsed=null,lastError=null,modelUsed=null;
     const redact=x=>{
       let v=limit(x,240);
       if(env.GEMINI_API_KEY)v=v.split(env.GEMINI_API_KEY).join('[REDACTED]');
       return v.replace(/AIza[A-Za-z0-9_-]{20,}/g,'[REDACTED]').replace(/\s+/g,' ').trim();
     };
     for(let i=0;i<models.length;i++){
       const model=models[i];
       if(!/^[a-zA-Z0-9._-]+$/.test(model))return reply({error:'Model AI chưa hợp lệ.'},503,allowed);
       const controller=new AbortController(),budget=i===0?14000:14000;
       const timer=setTimeout(()=>controller.abort(),budget),began=Date.now();
       let response=null,data=null;
       try{
         response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
           method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
           body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],
             // Keep this lightweight and model-agnostic: older Gemini models reject thinkingLevel,
             // while newer Flash-Lite models manage minimal thinking by default.
             generationConfig:{responseMimeType:'application/json',maxOutputTokens:1400}}),
           signal:controller.signal
         });
         data=await response.json().catch(()=>({}));
       }catch(err){
         lastError={status:controller.signal.aborted?504:502,error:controller.signal.aborted?
           'AI tạo gợi ý quá thời gian chờ.':'Không thể kết nối Gemini để tạo gợi ý.',detail:redact(err?.message||'')};
         attempts.push({model,status:controller.signal.aborted?'timeout':'network',elapsedMs:Date.now()-began});
       }finally{clearTimeout(timer)}
       if(response?.ok&&data){
         const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').replace(/^\`\`\`(?:json)?/i,'').replace(/\`\`\`$/,'').trim();
         try{parsed=JSON.parse(raw);modelUsed=model;attempts.push({model,status:200,elapsedMs:Date.now()-began});break}
         catch(_){lastError={status:502,error:'Gemini trả về gợi ý không đúng định dạng.'};attempts.push({model,status:'invalid-json',elapsedMs:Date.now()-began})}
       }else if(response&&!response.ok){
         const status=response.status,detail=redact(data?.error?.message||'');
         const locationUnsupported=isGeminiLocationError(status,(data?.error?.status||'')+' '+detail)||/not available in your location/i.test(detail);
         const invalidKey=status===400&&/api key not valid|api_key_invalid|invalid api key/i.test((data?.error?.status||'')+' '+detail);
         const category=locationUnsupported?'GEMINI_LOCATION_UNSUPPORTED':invalidKey?'GEMINI_AUTH':
           status===401?'GEMINI_AUTH':status===403?'GEMINI_PERMISSION':
           status===429?'GEMINI_QUOTA':status===404?'GEMINI_MODEL_NOT_FOUND':
           status>=500?'GEMINI_UPSTREAM':'GEMINI_REQUEST';
         lastError={
           status:locationUnsupported||invalidKey?503:(status===404?502:status),
           error:locationUnsupported
             ?'Gemini Idea Suggestions hiện không khả dụng từ môi trường máy chủ này.'
             :invalidKey?'Gemini API key không hợp lệ. Cần cập nhật secret GEMINI_API_KEY trên Cloudflare.'
             :'Gemini không thể tạo gợi ý ('+status+').',
           code:category,
           detail,
           help:locationUnsupported
             ?'Google từ chối request vì vị trí gửi request không được hỗ trợ. Đổi model/API key thường không khắc phục được lỗi này; cần kiểm tra đường truyền hoặc môi trường chạy Worker.'
             :invalidKey?'Thay GEMINI_API_KEY trong Cloudflare Worker bằng key hợp lệ từ Google AI Studio; không gửi key trong chat hoặc mã nguồn.'
             :status===429?'Gemini đang giới hạn quota hoặc tốc độ yêu cầu. Hãy kiểm tra quota trước khi thử lại.'
             :status===401||status===403?'Kiểm tra quyền và giới hạn của API key.'
             :status===404?'Kiểm tra tên model và quyền truy cập model.'
             :'Kiểm tra request và phản hồi Gemini.'
         };
         attempts.push({model,status,category,elapsedMs:Date.now()-began});
         // A location restriction is not model-specific. Do not waste a second
         // request against another model or disguise the upstream cause.
         console.warn('SpeakWise /hint upstream failure',JSON.stringify({
           category,upstreamStatus:status,model,elapsedMs:Date.now()-began
         }));
         if(locationUnsupported||invalidKey||[401,403,429].includes(status))break;
       }
       if(i<models.length-1)await new Promise(resolve=>setTimeout(resolve,350));
     }
     if(!parsed&&lastError&&env.AI?.run){
       try{
         parsed=await workersAiJson(env,prompt,1400);
         modelUsed='Cloudflare Workers AI ('+WORKERS_AI_TEXT_MODEL+')';
         attempts.push({model:WORKERS_AI_TEXT_MODEL,provider:'workers-ai',status:200});
       }catch(fallbackError){
         attempts.push({model:WORKERS_AI_TEXT_MODEL,provider:'workers-ai',status:'error'});
         lastError={...lastError,fallbackError:describeAIError(fallbackError)};
       }
     }
     if(!parsed)return reply({...lastError,attempts,elapsedMs:Date.now()-started},lastError?.status===504?504:lastError?.status===503?503:502,allowed);
     const hints=(Array.isArray(parsed.hints)?parsed.hints:[]).slice(0,3).map(h=>({
       situation:limit(h?.situation,220).trim(),
       keywords:(Array.isArray(h?.keywords)?h.keywords:[]).slice(0,6).map(x=>limit(x,70).trim()).filter(Boolean),
       guidingQuestion:limit(h?.guidingQuestion,260).trim()
     })).filter(h=>h.situation&&h.keywords.length>=2&&h.guidingQuestion);
     if(!hints.length)return reply({error:'Gemini chưa tạo được gợi ý phù hợp. Hãy thử lại.'},502,allowed);
     return reply({hints,modelUsed,elapsedMs:Date.now()-started},200,allowed);
   }
   if(path==='/generate'){
     const topic=String(b.topic||'').trim().slice(0,90);
     const level=String(b.level||'').toUpperCase();
     const count=Number(b.count);
     if(topic.length<2||!['A1','A2','B1','B2','C1','C2'].includes(level)||
       !Number.isInteger(count)||count<1||count>20)
       return reply({error:'Cần chọn topic, CEFR A1–C2 và số lượng 1–20.'},400,allowed);
     const exclude=(Array.isArray(b.exclude)?b.exclude:[])
       .slice(0,70).map(x=>limit(x,100)).filter(Boolean);
     const model=env.GEMINI_MODEL||'gemini-3.5-flash-lite';
     if(!/^[a-zA-Z0-9._-]+$/.test(model))return reply({error:'Model chưa hợp lệ.'},503,allowed);
     const prompt='You design high-quality English speaking collocations for everyday life and IELTS Speaking. '+
       'Produce '+count+' practical, natural English collocations (multiword lexical combinations, not single words) on the topic '+
       JSON.stringify(topic)+' suitable for CEFR '+level+'. '+
       'For each: exact collocation in English, accurate concise Vietnamese meaning, a natural complete example sentence in English, '+
       'and a short usage note in Vietnamese (optional). Prefer widely transferable collocations. Avoid obscure language, duplicates, and: '+
       JSON.stringify(exclude)+'. Do not fabricate IPA. Output ONLY a JSON object with entries array of objects '+
       '{phrase:string,meaning:string,example:string,note:string}. All examples must actually use the collocation. '+
       'This is a draft for teacher review; output no markdown.';
     const c=new AbortController(),t=setTimeout(()=>c.abort(),33000);
     let response,data;
     try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
       method:'POST',
       headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
       body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],
         generationConfig:{temperature:0.45,responseMimeType:'application/json',
           maxOutputTokens:5500,thinkingConfig:{thinkingLevel:'minimal'}}}),
       signal:c.signal
     });data=await response.json().catch(()=>({}));}
     catch(err){return reply({error:c.signal.aborted?'Tạo collocations quá thời gian chờ. Vui lòng thử số lượng ít hơn.':'Không kết nối được Gemini.',code:c.signal.aborted?'GENERATE_TIMEOUT':'GENERATE_NETWORK'},502,allowed)}
     finally{clearTimeout(t)}
     if(!response.ok){
       let detail=limit(data?.error?.message||'',240);
       if(env.GEMINI_API_KEY)detail=detail.split(env.GEMINI_API_KEY).join('[REDACTED]');
       detail=detail.replace(/AIza[A-Za-z0-9_-]{20,}/g,'[REDACTED]');
       const locationUnsupported=isGeminiLocationError(response.status,(data?.error?.status||'')+' '+detail);
       const invalidKey=response.status===400&&/api key not valid|api_key_invalid|invalid api key/i.test((data?.error?.status||'')+' '+detail);
       if(locationUnsupported)console.warn('SpeakWise /generate location restriction',JSON.stringify({code:'GEMINI_LOCATION_UNSUPPORTED',upstreamStatus:response.status,model}));
       if(env.AI?.run){
         try{
           const generated=await workersAiJson(env,prompt,5500);
           const unique=new Set();
           const entries=(Array.isArray(generated.entries)?generated.entries:[]).slice(0,count).map(x=>({
             phrase:limit(x?.phrase,180).trim(),meaning:limit(x?.meaning,240).trim(),
             example:limit(x?.example,1000).trim(),note:limit(x?.note,500).trim()
           })).filter(x=>{
             const key=x.phrase.toLowerCase();
             if(x.phrase.length<3||!x.meaning||!x.example||!x.phrase.includes(' ')||unique.has(key))return false;
             unique.add(key);return true;
           });
           if(entries.length)return reply({entries,modelUsed:'Cloudflare Workers AI ('+WORKERS_AI_TEXT_MODEL+')',requested:count,generated:entries.length},200,allowed);
           throw new Error('Workers AI không trả về collocations hợp lệ.');
         }catch(fallbackError){
           return reply({error:invalidKey?'Gemini API key không hợp lệ và Workers AI fallback cũng thất bại.':'Gemini không xử lý được yêu cầu và Workers AI fallback cũng thất bại.',code:'AI_FALLBACK_FAILED',geminiDetail:detail,workersAIDetail:describeAIError(fallbackError)},503,allowed);
         }
       }
       return reply({
         error:locationUnsupported?'Gemini hiện từ chối request do điều kiện vị trí của kết nối máy chủ.':'Gemini không tạo được collocations ('+response.status+').',
         code:locationUnsupported?'GEMINI_LOCATION_UNSUPPORTED':'GEMINI_GENERATE_ERROR',
         detail,
         help:locationUnsupported?'Đây không phải lỗi nội dung collocations. Cần kiểm tra IP đầu ra và điều kiện truy cập Gemini với nhà cung cấp hạ tầng/Google.':'Kiểm tra cấu hình model, API key và quota.'
       },locationUnsupported?503:502,allowed);
     }
     const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
     let parsed;try{parsed=JSON.parse(raw)}catch(_){return reply({error:'Gemini trả về JSON không hợp lệ, vui lòng thử lại.'},502,allowed)}
     if(!Array.isArray(parsed.entries))return reply({error:'Gemini không trả về danh sách collocations.'},502,allowed);
     const unique=new Set();
     const entries=parsed.entries.slice(0,count).map(x=>({
       phrase:limit(x?.phrase,180).trim(),meaning:limit(x?.meaning,240).trim(),
       example:limit(x?.example,1000).trim(),note:limit(x?.note,500).trim()
     })).filter(x=>{
       const key=x.phrase.toLowerCase();
       if(x.phrase.length<3||!x.meaning||!x.example||!x.phrase.includes(' ')||unique.has(key))return false;
       unique.add(key);return true;
     });
     if(!entries.length)return reply({error:'Không có collocations hợp lệ, hãy thử lại.'},502,allowed);
     return reply({entries,modelUsed:model,requested:count,generated:entries.length},200,allowed);
   }
   const mode=b.mode;
   if(!['write','speak'].includes(mode)||typeof b.phrase!=='string'||!b.phrase.trim()||b.phrase.length>200)return reply({error:'Thiếu collocation hoặc mode.'},400,allowed);
   if(mode==='write'&&(!b.answer||typeof b.answer!=='string'||b.answer.trim().length<12))return reply({error:'Hãy nhập câu đủ nghĩa.'},400,allowed);
   if(mode==='speak'&&(!b.audioBase64||typeof b.audioBase64!=='string'||b.audioBase64.length>8e6||!/^[A-Za-z0-9+/=]+$/.test(b.audioBase64)))return reply({error:'Ghi âm không hợp lệ.'},400,allowed);
   const mime=String(b.mimeType||'audio/webm').toLowerCase();
   if(mode==='speak'&&!['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(mime))return reply({error:'Định dạng âm thanh chưa hỗ trợ.'},415,allowed);
   const prompt='You are an English tutor evaluating ONE student-produced sentence using a target collocation. Be accurate and constructive, preserve their ideas. Not an official IELTS band score. '+JSON.stringify({targetCollocation:limit(b.phrase,200),meaning:limit(b.meaning,300),topic:limit(b.topic,300),mode,studentText:mode==='write'?limit(b.answer,2000):''})+' In speech mode transcribe heard speech accurately, including errors; never invent a transcript. Rate targetUsage, grammar, naturalness, clarity, and if speech pronunciation, each 0–100. Give feedback IN VIETNAMESE, without inventing errors. Return ONLY JSON object {score:number,dimensions:{targetUsage:number,grammar:number,naturalness:number,clarity:number,pronunciation:number|null},transcript:string,strengths:string[],improvements:string[],highlights:[{text:string,label:"good"|"improve"}],suggestedRevision:string}. Highlights MUST match exact uninterrupted parts of the provided or transcribed answer. suggestedRevision should be minimal and keep user meaning. Missing target phrase means low targetUsage score.';
   const parts=[{text:prompt}];
   if(mode==='speak')parts.push({inline_data:{mime_type:mime,data:b.audioBase64}});
   // Short first attempt with a low-latency multimodal model, then one fallback.
   // Keep the combined time below the browser's 60-second timeout.
   const mainModel=env.GEMINI_MODEL||'gemini-3.5-flash-lite';
   const fallbackModel=env.GEMINI_FALLBACK_MODEL||'gemini-3.8-flash';
   const models=[...new Set([mainModel,fallbackModel])].slice(0,2);
   if(models.some(m=>!/^[a-zA-Z0-9._-]+$/.test(m)))throw new Error('Invalid model');
   const totalStart=Date.now();
   const attempts=[];
   const apiUrl=m=>'https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent';
   const redact=x=>{
     let value=limit(x,320);
     if(env.GEMINI_API_KEY)value=value.split(env.GEMINI_API_KEY).join('[REDACTED]');
     return value.replace(/AIza[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
       .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email ẩn]')
       .replace(/\s+/g,' ').trim();
   };
   let payload=null,modelUsed=null,lastError=null,workerTranscript='';
   for(let i=0;i<models.length;i++){
     const selected=models[i],began=Date.now();
     const isLite=selected.includes('flash-lite');
     // Gemini 3.8 supports "low", whereas Flash-Lite supports "minimal".
     const generationConfig={
       temperature:0.2,responseMimeType:'application/json',
       maxOutputTokens:mode==='speak'?1900:1400,
       thinkingConfig:{thinkingLevel:isLite?'minimal':'low'}
     };
     const controller=new AbortController();
     const budget=i===0?20000:26000;
     const timer=setTimeout(()=>controller.abort(),budget);
     let response=null,body=null,aborted=false;
     try{
       response=await fetch(apiUrl(selected),{
         method:'POST',
         headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
         body:JSON.stringify({contents:[{role:'user',parts}],generationConfig}),
         signal:controller.signal
       });
       body=await response.json().catch(()=>({}));
     }catch(err){
       aborted=controller.signal.aborted||err?.name==='AbortError';
       lastError={
         status:aborted?504:502,
         error:aborted?'Gemini quá thời gian chờ trong lần gọi này.':'Không thể kết nối Gemini từ Cloudflare.',
         code:aborted?'GEMINI_TIMEOUT':'GEMINI_NETWORK',
         detail:redact(err?.message||''),
         help:'Dịch vụ Gemini có thể đang quá tải. Hãy thử lại sau hoặc kiểm tra Google AI Studio.'
       };
       attempts.push({model:selected,status:aborted?'timeout':'network',elapsedMs:Date.now()-began});
     }finally{clearTimeout(timer)}
     if(response?.ok&&body){
       payload=body;modelUsed=selected;
       attempts.push({model:selected,status:200,elapsedMs:Date.now()-began});
       break;
     }
     if(response&&!response.ok){
       const status=response.status,upstream=body?.error||{};
       const message=redact(upstream.message||'');
       const code=limit(upstream.status||'UNKNOWN',50).replace(/[^A-Z0-9_]/gi,'');
       const locationUnsupported=isGeminiLocationError(status,code+' '+message);
       const invalidKey=status===400&&/api key not valid|api_key_invalid|invalid api key/i.test(code+' '+message);
       const reason={
         400:locationUnsupported?'Google từ chối request do điều kiện vị trí của kết nối máy chủ; không phải lỗi câu viết hay định dạng âm thanh.':invalidKey?'GEMINI_API_KEY trên Cloudflare không hợp lệ hoặc đã bị thu hồi; cần cập nhật secret.':'Yêu cầu chưa được Gemini chấp nhận; cần kiểm tra câu viết hoặc định dạng âm thanh.',
         401:'API key không hợp lệ hoặc không được cấp quyền.',
         403:'API key bị giới hạn hoặc Gemini không cho phép yêu cầu này.',
         404:'Model không hỗ trợ API hoặc chưa khả dụng với tài khoản.',
         429:'Đã gặp giới hạn yêu cầu hoặc quota. Kiểm tra AI Studio, tránh thử liên tục.',
         500:'Máy chủ Gemini gặp lỗi tạm thời.',
         503:'Gemini đang quá tải hoặc tạm không khả dụng.'
       };
       lastError={status:locationUnsupported?503:status,
         error:locationUnsupported?'Gemini tạm thời không thể xử lý yêu cầu do giới hạn vị trí kết nối.':'Gemini trả về lỗi '+status+(code&&code!=='UNKNOWN'?' ('+code+')':'')+'.',
         code:locationUnsupported?'GEMINI_LOCATION_UNSUPPORTED':'GEMINI_'+status,detail:message,help:reason[status]||'Kiểm tra Google AI Studio.'};
       attempts.push({model:selected,status,elapsedMs:Date.now()-began});
       console.warn('Speakwise Gemini status',JSON.stringify({model:selected,status,elapsedMs:Date.now()-began}));
       // 400/401/403 are request/key errors. 429 may be a hard daily quota.
       // Trying another model would hide the cause and may waste quota.
       if([400,401,403,429].includes(status))break;
     }
     // One fallback on 404 (model inaccessible), 5xx, network error or timeout.
     if(i<models.length-1)await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(!payload&&lastError&&env.AI?.run){
     try{
       if(mode==='speak')workerTranscript=await workersAiTranscribe(env,b.audioBase64);
       const workersPrompt=mode==='speak'
         ?prompt.replace('In speech mode transcribe heard speech accurately, including errors; never invent a transcript.','In speech mode, use the supplied Whisper transcript exactly and do not invent words.')
             .replace('and if speech pronunciation, each 0–100.','Do not score pronunciation from a transcript; set pronunciation to null.')
             +' Whisper transcript: '+JSON.stringify(workerTranscript)+'. Preserve the exact transcript in the transcript field.'
         :prompt;
       const evaluated=await workersAiJson(env,workersPrompt,mode==='speak'?1900:1400);
       if(mode==='speak'&&!evaluated.transcript)evaluated.transcript=workerTranscript;
       payload={candidates:[{content:{parts:[{text:JSON.stringify(evaluated)}]}}]};
       modelUsed='Cloudflare Workers AI ('+WORKERS_AI_TEXT_MODEL+(mode==='speak'?' + Whisper':'')+')';
       attempts.push({model:WORKERS_AI_TEXT_MODEL,provider:'workers-ai',status:200});
     }catch(fallbackError){
       attempts.push({model:WORKERS_AI_TEXT_MODEL,provider:'workers-ai',status:'error'});
       lastError={...lastError,fallbackError:describeAIError(fallbackError)};
     }
   }
   if(!payload){
     const error=lastError||{status:503,error:'Gemini không có phản hồi.',code:'GEMINI_UNKNOWN',help:'Thử lại sau.'};
     return reply({
       ...error,
       detail:error.detail||'',
       modelsTried:attempts.map(a=>a.model),
       attempts,
       elapsedMs:Date.now()-totalStart
     },error.status===504?504:error.status===503?503:502,allowed);
   }
   const text=(payload.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').replace(/^\`\`\`(?:json)?/i,'').replace(/\`\`\`$/,'').trim();
   let o;try{o=JSON.parse(text)}catch{return reply({error:'Phản hồi Gemini không đúng định dạng JSON.'},502,allowed)}
   const d=o.dimensions||{}, dims={targetUsage:score(d.targetUsage),grammar:score(d.grammar),naturalness:score(d.naturalness),clarity:score(d.clarity)};
   if(mode==='speak'&&d.pronunciation!=null)dims.pronunciation=score(d.pronunciation);
   if(score(o.score)===null||Object.values(dims).some(x=>x===null))return reply({error:'AI chưa trả về điểm hợp lệ.'},502,allowed);
   const result={score:score(o.score),dimensions:dims,transcript:mode==='speak'?limit(o.transcript||workerTranscript,2000):'',strengths:(Array.isArray(o.strengths)?o.strengths:[]).slice(0,4).map(x=>limit(x,300)),improvements:(Array.isArray(o.improvements)?o.improvements:[]).slice(0,4).map(x=>limit(x,300)),highlights:(Array.isArray(o.highlights)?o.highlights:[]).slice(0,12).filter(x=>x&&['good','improve'].includes(x.label)&&x.text).map(x=>({text:limit(x.text,180),label:x.label})),suggestedRevision:limit(o.suggestedRevision,2000)};
   return reply({result,modelUsed,elapsedMs:Date.now()-totalStart},200,allowed);
  }catch(e){return reply({error:e.name==='AbortError'?'AI phản hồi quá lâu.':'Không thể chấm: '+limit(e.message,180)},502,allowed)}
 }
};