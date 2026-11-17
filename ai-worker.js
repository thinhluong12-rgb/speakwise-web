/**
 * Speakwise AI tutor API (Cloudflare Workers).
 * Secrets: GEMINI_API_KEY (optional when Workers AI is available), OPENAI_API_KEY (Realtime voice).
 * AI estimates only. Never use API keys client-side.
 */
const headers=(origin)=>({'content-type':'application/json; charset=utf-8','access-control-allow-origin':origin,'access-control-allow-headers':'content-type, authorization','access-control-allow-methods':'GET, POST, OPTIONS','cache-control':'no-store','vary':'Origin','x-content-type-options':'nosniff'});
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
 // JSON Mode can return response as an object; non-JSON mode returns a string.
 const structured=result&&typeof result==='object'&&result.response&&typeof result.response==='object'&&!Array.isArray(result.response)
   ?result.response:null;
 if(structured)return structured;
 const raw=typeof result==='string'?result:(typeof result?.response==='string'?result.response:result?.output_text||result?.text||'');
 if(!raw)throw new Error('Workers AI returned an unsupported response shape. '+describeAIError(result));
 const clean=String(raw).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try{return JSON.parse(clean)}catch(parseError){throw new Error('Workers AI returned invalid JSON: '+describeAIError(parseError))}
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

const verifySupabaseUser=async(req,env)=>{
 const token=String(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
 if(!token||!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)return null;
 const response=await fetch(env.SUPABASE_URL.replace(/\/$/,'')+'/auth/v1/user',{
  headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,authorization:'Bearer '+token}
 });
 if(!response.ok)return null;
 const user=await response.json().catch(()=>null);
 return user&&user.id?{id:user.id}:null;
};
const sha256Hex=async(value)=>{
 const bytes=new TextEncoder().encode(String(value));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
};
const voiceAnalysisPrompt=(topic,level,turns)=>{
 const learnerTurns=turns.filter(t=>t.speaker==='user'&&t.status!=='partial'&&String(t.text||'').trim());
 return 'You are a careful IELTS Speaking learning analyst. Analyse only the learner turns, using Coach AI turns only as conversational context. Do not invent evidence. Topic: '+JSON.stringify(topic)+'. CEFR level: '+level+'. Learner turns: '+JSON.stringify(learnerTurns.map(t=>({text:limit(t.text,1200),occurred_at:t.occurred_at})))+'. '+
 'Do not provide an official IELTS band score or a precise numerical band. Separate observed evidence from interpretation. Assess Fluency and Coherence only cautiously from turn structure and transcript; transcript does not preserve all pauses, hesitation, rhythm or repair behaviour. Assess Lexical Resource and Grammatical Range and Accuracy using exact phrases from the learner transcript. Pronunciation MUST be marked not_assessed because no audio recording is supplied to this analysis endpoint. '+
 'For each assessable criterion provide status ("observed" or "insufficient_evidence"), summary, up to 3 evidence items with exact quote and interpretation, confidence ("low","medium","high"), and one next_action. Include overall_summary, strengths (max 4), priority_improvements (max 4), corrections (max 5 with original, suggested, explanation), and practice_plan (max 3). Keep feedback constructive, specific and appropriate for the stated CEFR level. Do not claim a pronunciation result. Return only JSON matching: {"overall_summary":string,"criteria":{"fluency_coherence":{"status":string,"summary":string,"evidence":[{"quote":string,"interpretation":string}],"confidence":string,"next_action":string},"lexical_resource":{...},"grammatical_range_accuracy":{...},"pronunciation":{"status":"not_assessed","summary":string,"evidence":[],"confidence":"none","next_action":string}},"strengths":[string],"priority_improvements":[string],"corrections":[{"original":string,"suggested":string,"explanation":string}],"practice_plan":[string]}';
};
const runVoiceAnalysis=async(env,prompt)=>{
 let lastError='';
 if(env.GEMINI_API_KEY){
  const model=env.GEMINI_MODEL||'gemini-3.5-flash-lite';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),22000);
  try{
   const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
    method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.2,responseMimeType:'application/json',maxOutputTokens:2200}}),
    signal:controller.signal
   });
   const data=await response.json().catch(()=>({}));
   if(response.ok){
    const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
    try{return JSON.parse(raw)}catch(e){lastError='Gemini returned invalid JSON';}
   }else lastError=limit(data?.error?.message||('Gemini HTTP '+response.status),220);
  }catch(e){lastError=controller.signal.aborted?'Gemini analysis timed out':describeAIError(e)}
  finally{clearTimeout(timer)}
 }
 if(env.AI?.run){
  try{return await workersAiJson(env,prompt,2200)}
  catch(e){lastError=(lastError?lastError+'; ':'')+describeAIError(e)}
 }
 throw new Error(lastError||'No analysis provider is configured.');
};

export default {
 async fetch(req,env) {
  const url=new URL(req.url),path=url.pathname;
  if(!['/evaluate','/health','/generate','/hint','/conversation','/voice/session','/voice/analyze'].includes(path)){return env.ASSETS?.fetch(req)||new Response('Not found',{status:404})}
  const allowed=String(env.ALLOWED_ORIGIN||url.origin).replace(/\/$/,'');
  const incoming=req.headers.get('origin');
  if(incoming&&incoming!==allowed)return new Response('Origin not allowed',{status:403});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(allowed)});
  if(path==='/health'&&req.method==='GET')return reply({ok:true,aiReady:!!env.GEMINI_API_KEY||!!env.AI?.run,voiceReady:!!env.OPENAI_API_KEY&&!!env.SUPABASE_URL&&!!env.SUPABASE_PUBLISHABLE_KEY,providers:{gemini:!!env.GEMINI_API_KEY,workersAI:!!env.AI?.run},model:env.GEMINI_MODEL||'gemini-3.5-flash-lite',fallbackModel:env.GEMINI_FALLBACK_MODEL||'gemini-3.8-flash',workersAIModel:WORKERS_AI_TEXT_MODEL},200,allowed);
  if(!['/evaluate','/generate','/hint','/conversation','/voice/session','/voice/analyze'].includes(path)||req.method!=='POST')return reply({error:'Method not allowed'},405,allowed);
  if(path!=='/voice/session'&&!env.GEMINI_API_KEY&&!env.AI?.run)return reply({error:'AI chưa được cấu hình: cần GEMINI_API_KEY hoặc Workers AI binding.'},503,allowed);
  try{
   if(Number(req.headers.get('content-length')||0)>9e6)return reply({error:'Ghi âm quá lớn.'},413,allowed);
   const raw=await req.text();
   if(raw.length>9e6)return reply({error:'Yêu cầu quá lớn.'},413,allowed);
   let b;try{b=JSON.parse(raw)}catch{return reply({error:'JSON không hợp lệ.'},400,allowed)}


   if(path==='/voice/session'){
     if(!env.OPENAI_API_KEY)return reply({error:'Voice Mode chưa được cấu hình. Thiếu OPENAI_API_KEY trên Worker.'},503,allowed);
     if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)return reply({error:'Voice Mode chưa được cấu hình xác thực Supabase.'},503,allowed);
     const user=await verifySupabaseUser(req,env);
     if(!user)return reply({error:'Bạn cần đăng nhập SpeakWise trước khi bắt đầu Voice Mode.'},401,allowed);
     const dayStart=new Date();dayStart.setUTCHours(0,0,0,0);
     const usageResponse=await fetch(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/speakwise_voice_sessions?owner_id=eq.'+encodeURIComponent(user.id)+'&started_at=gte.'+encodeURIComponent(dayStart.toISOString())+'&select=id',{
       headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,authorization:'Bearer '+String(req.headers.get('authorization')||'')}
     });
     const usageRows=await usageResponse.json().catch(()=>[]);
     if(!usageResponse.ok||!Array.isArray(usageRows))return reply({error:'Không thể kiểm tra hạn mức Voice Mode.'},503,allowed);
     if(usageRows.length>=5)return reply({error:'Bạn đã đạt giới hạn 5 phiên Voice Mode trong ngày. Hãy quay lại vào ngày mai.'},429,allowed);
     const topic=limit(b.topic,120).trim()||'Daily conversation';
     const level=['A2','B1','B2','C1'].includes(String(b.level||'').toUpperCase())?String(b.level).toUpperCase():'B1';
     const goals=(Array.isArray(b.learningGoals)?b.learningGoals:[]).slice(0,5).map(x=>limit(x,120).trim()).filter(Boolean);
     const mode=['conversation','ielts_part_1','ielts_part_2','ielts_part_3'].includes(b.mode)?b.mode:'conversation';
     const model=env.OPENAI_REALTIME_MODEL||'gpt-realtime-1.5';
     const instructions='You are Coach AI in SpeakWise Speaking Lab. Have a natural, supportive but purposeful spoken English conversation. Topic: '+topic+'. Learner CEFR level: '+level+'. Session mode: '+mode+'. Learning goals: '+(goals.join('; ')||'develop ideas, speak clearly, and use natural English')+'. Ask one question at a time, listen carefully, respond concisely, and invite the learner to elaborate. Adapt vocabulary and question complexity to the stated level. Do not give an IELTS band score during the live conversation. Do not dominate the conversation or turn every reply into a lecture.';
     const safetyIdentifier=await sha256Hex('speakwise:'+user.id);
     const response=await fetch('https://api.openai.com/v1/realtime/client_secrets',{
       method:'POST',
       headers:{'content-type':'application/json','authorization':'Bearer '+env.OPENAI_API_KEY,'OpenAI-Safety-Identifier':safetyIdentifier},
       body:JSON.stringify({
         expires_after:{anchor:'created_at',seconds:60},
         session:{
           type:'realtime',
           model,
           instructions,
           output_modalities:['audio','text'],
           audio:{
             input:{
               transcription:{model:env.OPENAI_TRANSCRIPTION_MODEL||'gpt-4o-mini-transcribe',language:'en'},
               turn_detection:{type:'server_vad',create_response:true,interrupt_response:true}
             },
             output:{voice:env.OPENAI_REALTIME_VOICE||'marin'}
           }
         }
       })
     });
     const data=await response.json().catch(()=>({}));
     if(!response.ok){
       console.warn('SpeakWise Realtime session error',JSON.stringify({status:response.status,code:data?.error?.code||'unknown'}));
       return reply({error:'Không thể tạo Realtime session.',detail:limit(data?.error?.message||('OpenAI HTTP '+response.status),220)},502,allowed);
     }
     const secret=data.value||data.client_secret?.value;
     if(!secret)return reply({error:'OpenAI không trả về client secret hợp lệ.'},502,allowed);
     return reply({clientSecret:secret,expiresAt:data.expires_at||data.client_secret?.expires_at||null,sessionId:data.session?.id||null,model},200,allowed);
   }
   if(path==='/voice/analyze'){
     if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)return reply({error:'Thiếu cấu hình Supabase.'},503,allowed);
     const user=await verifySupabaseUser(req,env);
     if(!user)return reply({error:'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.'},401,allowed);
     const sessionId=String(b.sessionId||'');
     if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))return reply({error:'Session ID không hợp lệ.'},400,allowed);
     const sessionResponse=await fetch(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/speakwise_voice_sessions?id=eq.'+encodeURIComponent(sessionId)+'&select=id,owner_id,topic,cefr_level',{
       headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,authorization:'Bearer '+String(req.headers.get('authorization')||'')}
     });
     const sessions=await sessionResponse.json().catch(()=>[]);
     if(!sessionResponse.ok||!Array.isArray(sessions)||!sessions.length||sessions[0].owner_id!==user.id)return reply({error:'Không tìm thấy buổi học hoặc bạn không có quyền truy cập.'},404,allowed);
     const turnsResponse=await fetch(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/speakwise_voice_turns?session_id=eq.'+encodeURIComponent(sessionId)+'&select=turn_id,speaker,text,status,occurred_at&order=turn_index.asc&limit=100',{
       headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,authorization:'Bearer '+String(req.headers.get('authorization')||'')}
     });
     const storedTurns=await turnsResponse.json().catch(()=>[]);
     if(!turnsResponse.ok||!Array.isArray(storedTurns))return reply({error:'Không thể tải transcript đã lưu để phân tích.'},503,allowed);
     const turns=storedTurns.map(t=>({
       speaker:t?.speaker==='assistant'?'assistant':'user',
       text:limit(t?.text,12000),
       status:['partial','final','interrupted'].includes(t?.status)?t.status:'final',
       occurred_at:limit(t?.occurred_at,50)||new Date().toISOString(),
       turn_id:limit(t?.turn_id,120)
     })).filter(t=>t.text.trim());
     if(!turns.some(t=>t.speaker==='user'&&t.status!=='partial'))return reply({error:'Chưa có câu trả lời đủ nội dung để phân tích.'},400,allowed);
     const prompt=voiceAnalysisPrompt(sessions[0].topic,sessions[0].cefr_level,turns);
     try{
       const report=await runVoiceAnalysis(env,prompt);
       const criteria=report.criteria&&typeof report.criteria==='object'?report.criteria:{};
       const cleanCriterion=c=>({
         status:['observed','insufficient_evidence'].includes(c?.status)?c.status:'insufficient_evidence',
         summary:limit(c?.summary,700),
         evidence:(Array.isArray(c?.evidence)?c.evidence:[]).slice(0,3).map(x=>({quote:limit(x?.quote,300),interpretation:limit(x?.interpretation,350)})).filter(x=>x.quote),
         confidence:['low','medium','high'].includes(c?.confidence)?c.confidence:'low',
         next_action:limit(c?.next_action,350)
       });

       report.criteria={
         fluency_coherence:cleanCriterion(criteria.fluency_coherence),
         lexical_resource:cleanCriterion(criteria.lexical_resource),
         grammatical_range_accuracy:cleanCriterion(criteria.grammatical_range_accuracy),
         pronunciation:{status:'not_assessed',summary:'Chưa đánh giá phát âm vì quy trình này chỉ nhận transcript, không phân tích tín hiệu âm thanh.',evidence:[],confidence:'none',next_action:'Cần một quy trình phân tích audio chuyên biệt trước khi đưa ra nhận xét phát âm.'}
       };
       report.overall_summary=limit(report.overall_summary,1200);
       report.strengths=(Array.isArray(report.strengths)?report.strengths:[]).slice(0,4).map(x=>limit(x,300));
       report.priority_improvements=(Array.isArray(report.priority_improvements)?report.priority_improvements:[]).slice(0,4).map(x=>limit(x,300));
       report.corrections=(Array.isArray(report.corrections)?report.corrections:[]).slice(0,5).map(x=>({original:limit(x?.original,300),suggested:limit(x?.suggested,300),explanation:limit(x?.explanation,400)})).filter(x=>x.original&&x.suggested);
       report.practice_plan=(Array.isArray(report.practice_plan)?report.practice_plan:[]).slice(0,3).map(x=>limit(x,400));
       return reply({report,modelUsed:env.GEMINI_API_KEY?'Gemini':'Cloudflare Workers AI'},200,allowed);
     }catch(error){
       return reply({error:'Không thể tạo báo cáo Speaking.',detail:limit(error.message,260)},503,allowed);
     }
   }

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
   if(path==='/conversation'){
     const topic=limit(b.topic,100).trim()||'Everyday conversation';
     const level=['A2','B1','B2','C1'].includes(String(b.level||'').toUpperCase())?String(b.level).toUpperCase():'B1';
     const mode=b.mode==='speak'?'speak':b.mode==='start'?'start':'text';
     let userText=limit(b.message,1400).trim();
     if(mode==='speak'){
       if(typeof b.audioBase64!=='string'||b.audioBase64.length<1000||b.audioBase64.length>8e6||!/^[A-Za-z0-9+/=]+$/.test(b.audioBase64))
         return reply({error:'Ghi âm không hợp lệ hoặc vượt giới hạn 6MB.'},400,allowed);
       const mime=String(b.mimeType||'audio/webm').toLowerCase();
       if(!['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(mime))
         return reply({error:'Định dạng ghi âm chưa được hỗ trợ.'},415,allowed);
       try{userText=await workersAiTranscribe(env,b.audioBase64)}
       catch(transcribeError){return reply({error:'Không thể chuyển giọng nói thành văn bản.',detail:describeAIError(transcribeError)},502,allowed)}
     }else if(mode==='text'&&userText.length<2){
       return reply({error:'Hãy nhập câu trả lời trước khi gửi.'},400,allowed);
     }
     if(userText.length>1400)userText=userText.slice(0,1400);
     const history=(Array.isArray(b.history)?b.history:[]).slice(-12).map(m=>({
       role:m?.role==='assistant'?'assistant':'user',content:limit(m?.content,1400).trim()
     })).filter(m=>m.content);
     const targets=(Array.isArray(b.targetCollocations)?b.targetCollocations:[]).slice(0,8).map(x=>limit(x,100).trim()).filter(Boolean);
     const isStart=mode==='start';
     const prompt='You are SpeakWise Speaking Lab, a warm but rigorous English conversation partner and collocation coach. '+
       (isStart
         ?'Start a new, natural spoken conversation about '+JSON.stringify(topic)+' at CEFR '+level+'. The learner has explicitly pressed the start button and has not spoken yet. Open with a brief, friendly greeting and exactly ONE engaging, easy-to-answer question directly related to this topic. Do not ask a generic question unrelated to the selected topic. Keep the opening concise and welcoming. '
         :'Continue a realistic spoken conversation about '+JSON.stringify(topic)+' at CEFR '+level+'. ')+
       'Conversation history (oldest first): '+JSON.stringify(history)+'. Latest learner turn: '+JSON.stringify(userText)+'. '+
       'Optional collocations the learner wants to practise: '+JSON.stringify(targets)+'. '+
       (isStart?'As this is the opening turn, provide no learner feedback; return an empty feedback object. ':'Respond naturally to what the learner actually said, then ask exactly ONE relevant follow-up question in assistantMessage. ')+
       'Do not turn every response into a lecture or force collocations. Prioritise natural, context-appropriate language over complexity. '+
       'Assess only evidence in the latest learner turn. feedback should be concise and in Vietnamese. '+
       'collocationsUsed: list exact collocations genuinely used by learner, with a brief note on whether usage is natural. '+
       'corrections: only genuine unnatural or incorrect word combinations, each with original, suggested, and explanation; do not invent errors. '+
       'opportunities: at most 3 natural collocations that could improve this specific response, with Vietnamese meaning and a short example fragment; do not imply the learner must use all of them. '+
       'If the answer is already natural, say so and avoid unnecessary rewriting. suggestedRevision should preserve meaning and be minimal; empty string if no revision is needed. '+
       'Return ONLY JSON: {assistantMessage:string,feedback:{overall:string,collocationsUsed:[{phrase:string,note:string}],corrections:[{original:string,suggested:string,explanation:string}],opportunities:[{phrase:string,meaning:string,example:string}],suggestedRevision:string,oneTip:string}}';
     const model=env.GEMINI_MODEL||'gemini-3.5-flash-lite';
     let result=null,modelUsed=null,geminiDetail='';
     if(env.GEMINI_API_KEY){
       const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
       try{
         const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
           method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
           body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],
             generationConfig:{temperature:0.35,responseMimeType:'application/json',maxOutputTokens:1500}}),
           signal:controller.signal
         });
         const data=await response.json().catch(()=>({}));
         if(response.ok){
           const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
           try{result=JSON.parse(raw);modelUsed=model}catch(parseError){geminiDetail='Gemini returned invalid JSON: '+describeAIError(parseError)}
         }else{
           geminiDetail=limit(data?.error?.message||('Gemini HTTP '+response.status),260);
         }
       }catch(err){geminiDetail=controller.signal.aborted?'Gemini timeout':describeAIError(err)}
       finally{clearTimeout(timer)}
     }else{geminiDetail='Gemini API key is not configured.'}
     if(!result&&env.AI?.run){
       try{result=await workersAiJson(env,prompt,1500);modelUsed='Cloudflare Workers AI ('+WORKERS_AI_TEXT_MODEL+')'}
       catch(fallbackError){return reply({error:'AI conversation hiện không khả dụng.',detail:geminiDetail,workersAIDetail:describeAIError(fallbackError)},503,allowed)}
     }
     if(!result)return reply({error:'Chưa có nhà cung cấp AI khả dụng cho Speaking Lab.',detail:geminiDetail},503,allowed);
     const feedback=result.feedback&&typeof result.feedback==='object'?result.feedback:{};
     const cleanList=(arr,max,mapper)=>Array.isArray(arr)?arr.slice(0,max).map(mapper):[];
     const output={
       transcript:mode==='speak'?limit(userText,1400):'',
       assistantMessage:limit(result.assistantMessage,900).trim()||'Thanks for sharing. Could you tell me a little more?',
       feedback:{
         overall:limit(feedback.overall,500).trim(),
         collocationsUsed:cleanList(feedback.collocationsUsed,6,x=>({phrase:limit(x?.phrase,100),note:limit(x?.note,240)})).filter(x=>x.phrase),
         corrections:cleanList(feedback.corrections,4,x=>({original:limit(x?.original,180),suggested:limit(x?.suggested,180),explanation:limit(x?.explanation,240)})).filter(x=>x.original&&x.suggested),
         opportunities:cleanList(feedback.opportunities,3,x=>({phrase:limit(x?.phrase,100),meaning:limit(x?.meaning,180),example:limit(x?.example,220)})).filter(x=>x.phrase&&x.meaning),
         suggestedRevision:limit(feedback.suggestedRevision,900).trim(),
         oneTip:limit(feedback.oneTip,300).trim()
       },
       modelUsed
     };
     return reply(output,200,allowed);
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