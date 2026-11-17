/**
 * Speakwise AI tutor API (Cloudflare Workers).
 * Required secret: GEMINI_API_KEY.
 * AI estimates only. Never use API keys client-side.
 */
const headers=(origin)=>({'content-type':'application/json; charset=utf-8','access-control-allow-origin':origin,'access-control-allow-headers':'content-type','access-control-allow-methods':'POST, OPTIONS','cache-control':'no-store','vary':'Origin','x-content-type-options':'nosniff'});
const reply=(value,status,origin)=>new Response(JSON.stringify(value),{status,headers:headers(origin)});
const limit=(x,n=1400)=>String(x||'').slice(0,n);
const score=x=>Number.isFinite(Number(x))?Math.max(0,Math.min(100,Math.round(Number(x)))):null;
export default {
 async fetch(req,env) {
  const url=new URL(req.url),path=url.pathname;
  if(path!=='/evaluate'&&path!=='/health'&&path!=='/generate'&&path!=='/hint'){return env.ASSETS?.fetch(req)||new Response('Not found',{status:404})}
  const allowed=String(env.ALLOWED_ORIGIN||url.origin).replace(/\/$/,'');
  const incoming=req.headers.get('origin');
  if(incoming&&incoming!==allowed)return new Response('Origin not allowed',{status:403});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(allowed)});
  if(path==='/health'&&req.method==='GET')return reply({ok:true,aiReady:!!env.GEMINI_API_KEY,model:env.GEMINI_MODEL||'gemini-3.5-flash-lite',fallbackModel:env.GEMINI_FALLBACK_MODEL||'gemini-3.8-flash'},200,allowed);
  if(!['/evaluate','/generate','/hint'].includes(path)||req.method!=='POST')return reply({error:'Method not allowed'},405,allowed);
  if(!env.GEMINI_API_KEY)return reply({error:'AI chưa được cấu hình: thiếu GEMINI_API_KEY.'},503,allowed);
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
         // Match the proven /evaluate request configuration. Gemini 3.x models
         // use model-appropriate thinking levels; keep the same temperature and
         // JSON response mode used by Writing/Speaking evaluation.
         const isLite=model.includes('flash-lite');
         const generationConfig={
           temperature:0.2,
           responseMimeType:'application/json',
           maxOutputTokens:1400,
           thinkingConfig:{thinkingLevel:isLite?'minimal':'low'}
         };
         response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
           method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
           body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig}),
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
         lastError={status:status===404?502:status,error:'Gemini không thể tạo gợi ý ('+status+').',detail};
         attempts.push({model,status,elapsedMs:Date.now()-began});
         if([401,403,429].includes(status))break;
       }
       if(i<models.length-1)await new Promise(resolve=>setTimeout(resolve,350));
     }
     if(!parsed)return reply({...lastError,attempts,elapsedMs:Date.now()-started},lastError?.status===504?504:502,allowed);
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
       return reply({error:'Gemini không tạo được collocations ('+response.status+').',detail},502,allowed);
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
   let payload=null,modelUsed=null,lastError=null;
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
       const reason={
         400:'Yêu cầu chưa được Gemini chấp nhận; cần kiểm tra câu viết hoặc định dạng âm thanh.',
         401:'API key không hợp lệ hoặc không được cấp quyền.',
         403:'API key bị giới hạn hoặc Gemini không cho phép yêu cầu này.',
         404:'Model không hỗ trợ API hoặc chưa khả dụng với tài khoản.',
         429:'Đã gặp giới hạn yêu cầu hoặc quota. Kiểm tra AI Studio, tránh thử liên tục.',
         500:'Máy chủ Gemini gặp lỗi tạm thời.',
         503:'Gemini đang quá tải hoặc tạm không khả dụng.'
       };
       lastError={status,error:'Gemini trả về lỗi '+status+(code&&code!=='UNKNOWN'?' ('+code+')':'')+'.',
         code:'GEMINI_'+status,detail:message,help:reason[status]||'Kiểm tra Google AI Studio.'};
       attempts.push({model:selected,status,elapsedMs:Date.now()-began});
       console.warn('Speakwise Gemini status',JSON.stringify({model:selected,status,elapsedMs:Date.now()-began}));
       // 400/401/403 are request/key errors. 429 may be a hard daily quota.
       // Trying another model would hide the cause and may waste quota.
       if([400,401,403,429].includes(status))break;
     }
     // One fallback on 404 (model inaccessible), 5xx, network error or timeout.
     if(i<models.length-1)await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(!payload){
     const error=lastError||{status:503,error:'Gemini không có phản hồi.',code:'GEMINI_UNKNOWN',help:'Thử lại sau.'};
     return reply({
       ...error,
       detail:error.detail||'',
       modelsTried:attempts.map(a=>a.model),
       attempts,
       elapsedMs:Date.now()-totalStart
     },error.status===504?504:502,allowed);
   }
   const text=(payload.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').replace(/^\`\`\`(?:json)?/i,'').replace(/\`\`\`$/,'').trim();
   let o;try{o=JSON.parse(text)}catch{return reply({error:'Phản hồi Gemini không đúng định dạng JSON.'},502,allowed)}
   const d=o.dimensions||{}, dims={targetUsage:score(d.targetUsage),grammar:score(d.grammar),naturalness:score(d.naturalness),clarity:score(d.clarity)};
   if(mode==='speak'&&d.pronunciation!=null)dims.pronunciation=score(d.pronunciation);
   if(score(o.score)===null||Object.values(dims).some(x=>x===null))return reply({error:'AI chưa trả về điểm hợp lệ.'},502,allowed);
   const result={score:score(o.score),dimensions:dims,transcript:mode==='speak'?limit(o.transcript,2000):'',strengths:(Array.isArray(o.strengths)?o.strengths:[]).slice(0,4).map(x=>limit(x,300)),improvements:(Array.isArray(o.improvements)?o.improvements:[]).slice(0,4).map(x=>limit(x,300)),highlights:(Array.isArray(o.highlights)?o.highlights:[]).slice(0,12).filter(x=>x&&['good','improve'].includes(x.label)&&x.text).map(x=>({text:limit(x.text,180),label:x.label})),suggestedRevision:limit(o.suggestedRevision,2000)};
   return reply({result,modelUsed,elapsedMs:Date.now()-totalStart},200,allowed);
  }catch(e){return reply({error:e.name==='AbortError'?'AI phản hồi quá lâu.':'Không thể chấm: '+limit(e.message,180)},502,allowed)}
 }
};