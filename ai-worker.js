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
  if(path!=='/evaluate'&&path!=='/health'){return env.ASSETS?.fetch(req)||new Response('Not found',{status:404})}
  const allowed=String(env.ALLOWED_ORIGIN||url.origin).replace(/\/$/,'');
  const incoming=req.headers.get('origin');
  if(incoming&&incoming!==allowed)return new Response('Origin not allowed',{status:403});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(allowed)});
  if(path==='/health'&&req.method==='GET')return reply({ok:true,aiReady:!!env.GEMINI_API_KEY},200,allowed);
  if(path!=='/evaluate'||req.method!=='POST')return reply({error:'Method not allowed'},405,allowed);
  if(!env.GEMINI_API_KEY)return reply({error:'AI chưa được cấu hình: thiếu GEMINI_API_KEY.'},503,allowed);
  try{
   if(Number(req.headers.get('content-length')||0)>9e6)return reply({error:'Ghi âm quá lớn.'},413,allowed);
   const raw=await req.text();
   if(raw.length>9e6)return reply({error:'Yêu cầu quá lớn.'},413,allowed);
   let b;try{b=JSON.parse(raw)}catch{return reply({error:'JSON không hợp lệ.'},400,allowed)}
   const mode=b.mode;
   if(!['write','speak'].includes(mode)||typeof b.phrase!=='string'||!b.phrase.trim()||b.phrase.length>200)return reply({error:'Thiếu collocation hoặc mode.'},400,allowed);
   if(mode==='write'&&(!b.answer||typeof b.answer!=='string'||b.answer.trim().length<12))return reply({error:'Hãy nhập câu đủ nghĩa.'},400,allowed);
   if(mode==='speak'&&(!b.audioBase64||typeof b.audioBase64!=='string'||b.audioBase64.length>8e6||!/^[A-Za-z0-9+/=]+$/.test(b.audioBase64)))return reply({error:'Ghi âm không hợp lệ.'},400,allowed);
   const mime=String(b.mimeType||'audio/webm').toLowerCase();
   if(mode==='speak'&&!['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(mime))return reply({error:'Định dạng âm thanh chưa hỗ trợ.'},415,allowed);
   const prompt='You are an English tutor evaluating ONE student-produced sentence using a target collocation. Be accurate and constructive, preserve their ideas. Not an official IELTS band score. '+JSON.stringify({targetCollocation:limit(b.phrase,200),meaning:limit(b.meaning,300),topic:limit(b.topic,300),mode,studentText:mode==='write'?limit(b.answer,2000):''})+' In speech mode transcribe heard speech accurately, including errors; never invent a transcript. Rate targetUsage, grammar, naturalness, clarity, and if speech pronunciation, each 0–100. Give feedback IN VIETNAMESE, without inventing errors. Return ONLY JSON object {score:number,dimensions:{targetUsage:number,grammar:number,naturalness:number,clarity:number,pronunciation:number|null},transcript:string,strengths:string[],improvements:string[],highlights:[{text:string,label:"good"|"improve"}],suggestedRevision:string}. Highlights MUST match exact uninterrupted parts of the provided or transcribed answer. suggestedRevision should be minimal and keep user meaning. Missing target phrase means low targetUsage score.';
   const parts=[{text:prompt}];
   if(mode==='speak')parts.push({inline_data:{mime_type:mime,data:b.audioBase64}});
   const model=env.GEMINI_MODEL||'gemini-2.5-flash';
   if(!/^[a-zA-Z0-9._-]+$/.test(model))throw new Error('Invalid model');
   const c=new AbortController(),t=setTimeout(()=>c.abort(),50000);let response;
   try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{temperature:0.2,responseMimeType:'application/json',maxOutputTokens:2800}}),signal:c.signal})}finally{clearTimeout(t)}
   const payload=await response.json().catch(()=>({}));
   if(!response.ok){
     const upstreamError=payload?.error||{};
     const status=response.status;
     const upstreamCode=limit(upstreamError.status||'UNKNOWN',50).replace(/[^A-Z0-9_]/gi,'');
     const reasonByStatus={
       400:'Gemini từ chối nội dung yêu cầu. Hãy thử câu Viết trước, rồi kiểm tra định dạng âm thanh nếu chỉ chế độ Nói bị lỗi.',
       401:'Xác thực Gemini thất bại. Kiểm tra API key trong Cloudflare Secrets.',
       403:'API key chưa được cấp quyền, bị giới hạn, hoặc Gemini không hỗ trợ yêu cầu từ môi trường hiện tại.',
       404:'Không tìm thấy model Gemini được cấu hình hoặc model không hỗ trợ API này.',
       408:'Yêu cầu tới Gemini hết thời gian chờ.',
       429:'Gemini đang giới hạn số yêu cầu hoặc đã hết quota. Kiểm tra Google AI Studio rồi thử lại sau.',
       500:'Máy chủ Gemini gặp lỗi tạm thời.',
       503:'Dịch vụ hoặc model Gemini đang quá tải hoặc tạm không khả dụng.'
     };
     const advice=reasonByStatus[status]||'Kiểm tra trạng thái API và cấu hình Gemini trong Google AI Studio.';
     let detail=limit(upstreamError.message||'',320);
     if(env.GEMINI_API_KEY)detail=detail.split(env.GEMINI_API_KEY).join('[REDACTED]');
     detail=detail.replace(/AIza[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
       .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email ẩn]')
       .replace(/\s+/g,' ').trim();
     console.warn('Speakwise Gemini upstream failed',JSON.stringify({status,upstreamCode,model}));
     return reply({
       error:'Gemini trả về lỗi '+status+(upstreamCode&&upstreamCode!=='UNKNOWN'?' ('+upstreamCode+')':'')+'.',
       code:'GEMINI_'+status,upstreamStatus:status,detail,help:advice
     },502,allowed);
   }
   const text=(payload.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').replace(/^\`\`\`(?:json)?/i,'').replace(/\`\`\`$/,'').trim();
   let o;try{o=JSON.parse(text)}catch{return reply({error:'Phản hồi Gemini không đúng định dạng JSON.'},502,allowed)}
   const d=o.dimensions||{}, dims={targetUsage:score(d.targetUsage),grammar:score(d.grammar),naturalness:score(d.naturalness),clarity:score(d.clarity)};
   if(mode==='speak'&&d.pronunciation!=null)dims.pronunciation=score(d.pronunciation);
   if(score(o.score)===null||Object.values(dims).some(x=>x===null))return reply({error:'AI chưa trả về điểm hợp lệ.'},502,allowed);
   const result={score:score(o.score),dimensions:dims,transcript:mode==='speak'?limit(o.transcript,2000):'',strengths:(Array.isArray(o.strengths)?o.strengths:[]).slice(0,4).map(x=>limit(x,300)),improvements:(Array.isArray(o.improvements)?o.improvements:[]).slice(0,4).map(x=>limit(x,300)),highlights:(Array.isArray(o.highlights)?o.highlights:[]).slice(0,12).filter(x=>x&&['good','improve'].includes(x.label)&&x.text).map(x=>({text:limit(x.text,180),label:x.label})),suggestedRevision:limit(o.suggestedRevision,2000)};
   return reply({result},200,allowed);
  }catch(e){return reply({error:e.name==='AbortError'?'AI phản hồi quá lâu.':'Không thể chấm: '+limit(e.message,180)},502,allowed)}
 }
};