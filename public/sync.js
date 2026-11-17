/* Optional Speakwise Supabase sync. Safe local-first fallback. */
(() => {
 'use strict';
 const cfg=window.SPEAKWISE_CONFIG||{};
 let api=null,user=null,ctx=null,timer=null,writing=false,loading=false;
 const $=id=>document.getElementById(id);
 const tell=msg=>ctx?.toast?.(msg);
 const label=msg=>{const el=$('syncButton');if(el)el.textContent=msg;};
 const enabled=()=>!!(api&&user&&ctx);
 function setGate(locked){
  document.documentElement.classList.toggle('sw-auth-required',!!locked);
  document.documentElement.classList.remove('sw-auth-pending');
 }
 function showDialog(required=false){
  let host=$('speakwiseSyncHost');
  if(!host){host=document.createElement('div');host.id='speakwiseSyncHost';document.body.append(host);}
  host.dataset.required=required?'1':'0';
  host.innerHTML='<div class="sw-sync-shade"></div><div class="sw-sync-modal" role="dialog" aria-modal="true" aria-labelledby="swSyncTitle"><button id="swSyncClose" type="button" class="sw-sync-close" aria-label="Đóng">×</button><h2 id="swSyncTitle">Đăng nhập SpeakWise</h2><p id="swSyncMessage"></p><div id="swSyncControls"></div><div class="sw-sync-login-note" id="swSyncNote">Đăng nhập để truy cập không gian học tập, Speaking Lab và đồng bộ tiến độ trên các thiết bị.</div><small>Thông tin đăng nhập được xử lý an toàn qua Supabase Authentication.</small></div>';
  host.classList.add('open');
  const close=()=>{if(host.dataset.required!=='1')host.classList.remove('open')};
  host.querySelector('.sw-sync-shade').addEventListener('click',close);
  $('swSyncClose').addEventListener('click',close);
  const message=$('swSyncMessage'),body=$('swSyncControls');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){
   message.textContent='Hệ thống đăng nhập chưa được cấu hình. Vui lòng liên hệ quản trị viên.';
   body.innerHTML='<p class="sw-sync-error">Thiếu Supabase URL hoặc publishable key trong config.js.</p>';
   $('swSyncClose').hidden=required;return;
  }
  if(!api){message.textContent='Đang kết nối dịch vụ tài khoản…';body.innerHTML='<p>Vui lòng chờ trong giây lát.</p>';return;}
  if(!user){
   message.textContent='Nhập email để nhận liên kết đăng nhập an toàn. Sau khi xác thực, website sẽ tự động mở khóa.';
   body.innerHTML='<label for="swSyncEmail">Địa chỉ email</label><input id="swSyncEmail" type="email" autocomplete="email" placeholder="name@example.com" required/><p class="sw-sync-error" id="swSyncError" hidden></p><button type="button" class="btn btn-primary sw-sync-submit" id="swSyncLogin">Gửi liên kết đăng nhập</button>';
   $('swSyncClose').hidden=required;
   $('swSyncLogin').addEventListener('click',async()=>{
    const email=$('swSyncEmail').value.trim(),button=$('swSyncLogin'),err=$('swSyncError');
    err.hidden=true;err.textContent='';
    if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Vui lòng nhập địa chỉ email hợp lệ.';err.hidden=false;return;}
    button.disabled=true;button.textContent='Đang gửi…';
    try{
     const {error}=await api.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
     if(error)throw error;
     message.textContent='Liên kết đăng nhập đã được gửi. Hãy mở email và bấm vào liên kết để xác thực. Website sẽ tự động mở sau khi xác thực thành công.';
     body.innerHTML='<p class="sw-sync-login-note">Đang chờ xác thực email. Hãy kiểm tra cả thư mục Spam/Quảng cáo nếu chưa thấy thư.</p><button type="button" class="btn btn-muted sw-sync-submit" id="swSyncResend">Nhập email khác / gửi lại</button>';
     $('swSyncResend').onclick=()=>showDialog(required);
    }catch(e){err.textContent=e.message||'Không gửi được email đăng nhập. Vui lòng thử lại.';err.hidden=false;button.disabled=false;button.textContent='Gửi liên kết đăng nhập';}
   });
  }else{
   message.textContent='Bạn đã đăng nhập với '+(user.email||'tài khoản SpeakWise')+'.';
   body.innerHTML='<button type="button" class="btn btn-primary sw-sync-submit" id="swSyncNow">Đồng bộ ngay</button><button type="button" class="btn btn-muted sw-sync-submit" id="swSyncLogout">Đăng xuất</button>';
   $('swSyncClose').hidden=false;
   $('swSyncNow').onclick=async()=>{await load();await push();host.classList.remove('open');};
   $('swSyncLogout').onclick=async()=>{const {error}=await api.auth.signOut();if(error){tell(error.message);return;}user=null;setGate(true);showDialog(true);label('Đăng nhập');tell('Bạn đã đăng xuất.');};
  }
 }
 function dialog(){showDialog(false)}
 async function load(){
  if(!enabled()||loading)return;loading=true;label('Tài khoản');
  try{
   const [topics,ents,progs,hiddens,activities,mistakes,prefs]=await Promise.all([
    api.from('speakwise_topics').select('*'),
    api.from('speakwise_entries').select('*'),
    api.from('speakwise_progress').select('*').eq('user_id',user.id),
    api.from('speakwise_hidden').select('entry_id').eq('user_id',user.id),
    api.from('speakwise_activity').select('*').eq('user_id',user.id).order('occurred_at',{ascending:false}).limit(1000),
    api.from('speakwise_mistakes').select('*').eq('user_id',user.id).limit(400),
    api.from('speakwise_preferences').select('*').eq('user_id',user.id).maybeSingle()
   ]);
   for(const r of [topics,ents,progs,hiddens,activities,mistakes,prefs])if(r.error)throw r.error;
   const st=ctx.store;
   for(const row of topics.data||[]){
     const t={id:row.id,name:row.name,vi:row.vi||row.name,section:row.section||'life',
       icon:row.icon||'book',desc:row.description||''};
     const i=st.topics.findIndex(x=>x.id===t.id);
     if(i<0)st.topics.push(t);else if(row.owner_id===null)st.topics[i]={...st.topics[i],...t};
   }
   for(const row of ents.data||[]){
    const e={id:row.id,topicId:row.topic_id,phrase:row.phrase,ipa:row.ipa||'',meaning:row.meaning,example:row.example,note:row.note||'',source:row.source||'Đã đồng bộ',addedAt:row.added_at||''};
    const ix=st.entries.findIndex(x=>x.id===e.id);
    if(ix<0)st.entries.push(e);
    else if(row.owner_id===null)st.entries[ix]={...st.entries[ix],...e};
   }
   for(const row of progs.data||[]){
    const old=st.progress[row.entry_id]||{};
    const l=old.evidence||{},remote=row.evidence||{};
    const evidence={...remote,...l,
      recallDays:[...new Set([...(remote.recallDays||[]),...(l.recallDays||[])])].sort().slice(-20),
      applyDays:[...new Set([...(remote.applyDays||[]),...(l.applyDays||[])])].sort().slice(-20),
      failures:Math.max(Number(l.failures)||0,Number(remote.failures)||0),
      mcqCorrect:Math.max(Number(l.mcqCorrect)||0,Number(remote.mcqCorrect)||0)};
    const newerLocal=old.lastReviewed&&row.last_reviewed&&old.lastReviewed>row.last_reviewed;
    st.progress[row.entry_id]={...old,
      level:newerLocal?old.level:row.level,
      reviews:Math.max(Number(old.reviews)||0,Number(row.reviews)||0),
      nextReview:newerLocal?old.nextReview:row.next_review,
      lastReviewed:newerLocal?old.lastReviewed:row.last_reviewed,
      starred:old.starred||row.starred,
      evidence,updatedAt:row.updated_at};
   }
   const known=new Set((st.reviewEvents||[]).map(e=>e.id));
   for(const row of activities.data||[]){
     const e={id:row.id,date:row.activity_day,entryId:row.entry_id,action:row.action,rating:'synced'};
     if(!known.has(e.id)){st.reviewEvents.push(e);known.add(e.id)}
   }
   const tombstones=new Set([...(st.deletedMistakeIds||[]),...(prefs.data?.data?.deletedMistakeIds||[])]);
   st.deletedMistakeIds=[...tombstones];
   const mistakeMap=new Map((st.mistakes||[]).filter(m=>!tombstones.has(m.id)).map(m=>[m.id,m]));
   for(const row of mistakes.data||[]){
     if(tombstones.has(row.id))continue;
     const converted={id:row.id,entryId:row.entry_id,mode:row.mode,
       originalText:row.original_text,revisedText:row.suggested_revision,
       note:row.note,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at};
     const old=mistakeMap.get(row.id);
     if(!old||!old.updatedAt||old.updatedAt<=row.updated_at)mistakeMap.set(row.id,converted);
   }
   st.mistakes=[...mistakeMap.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,400);
   if(prefs.data?.data){
     const rem=prefs.data.data;
     // Keep current device's in-progress session rather than overwriting it.
     st.settings={...st.settings,...(rem.settings||{})};
     if(!st.learningJourney&&rem.learningJourney)st.learningJourney=rem.learningJourney;
     if(!st.lastPractice&&rem.lastPractice)st.lastPractice=rem.lastPractice;
   }
   st.activityDates=[...new Set([...(st.activityDates||[]),...(activities.data||[]).map(x=>x.activity_day).filter(Boolean)])];
   st.reviewEvents=st.reviewEvents.slice(-3000);
   st.deletedIds=[...new Set([...(st.deletedIds||[]),...(hiddens.data||[]).map(x=>x.entry_id)])];
   st.entries=st.entries.filter(x=>!st.deletedIds.includes(x.id));
   try{localStorage.setItem('speakwise-collocation-studio-v1',JSON.stringify(st))}catch(_){}
   ctx.render();label('Tài khoản');
  }catch(e){label('Tài khoản');tell(e.message||String(e))}finally{loading=false}
 }
 async function push(){
  if(!enabled()||loading||writing)return;
  writing=true;
  try{
   const st=ctx.store,baseIds=new Set((window.SPEAKING_SEED?.entries||[]).map(x=>x.id));
   const baseTopicIds=new Set((window.SPEAKING_SEED?.topics||[]).map(x=>x.id));
   const customTopics=st.topics.filter(t=>!baseTopicIds.has(t.id)).map(t=>({
     id:t.id,owner_id:user.id,name:t.name,vi:t.vi||t.name,section:t.section||'life',
     icon:t.icon||'book',description:t.desc||''
   }));
   if(customTopics.length){const {error}=await api.from('speakwise_topics').upsert(customTopics,{onConflict:'id'});if(error)throw error;}
   const entries=st.entries.filter(e=>!baseIds.has(e.id)).map(e=>({id:e.id,owner_id:user.id,topic_id:e.topicId,phrase:e.phrase,ipa:e.ipa||'',meaning:e.meaning,example:e.example,note:e.note||'',source:e.source||'',added_at:e.addedAt||new Date().toISOString().slice(0,10)}));
   if(entries.length){const {error}=await api.from('speakwise_entries').upsert(entries,{onConflict:'id'});if(error)throw error;}
   const progress=Object.entries(st.progress).map(([entry_id,p])=>({user_id:user.id,entry_id,level:Math.max(0,Math.min(5,Number(p.level)||0)),reviews:Number(p.reviews)||0,next_review:p.nextReview||null,starred:!!p.starred,
     last_reviewed:p.lastReviewed||null,evidence:p.evidence||{}}));
   if(progress.length){const {error}=await api.from('speakwise_progress').upsert(progress,{onConflict:'user_id,entry_id'});if(error)throw error;}
   const activities=(st.reviewEvents||[]).map((e,i)=>({
     id:e.id||('legacy-'+e.date+'-'+e.entryId+'-'+i),
     user_id:user.id,entry_id:st.entries.some(x=>x.id===e.entryId)?e.entryId:null,
     action:['flashcard','mcq','recall','write','speak'].includes(e.action)?e.action:'flashcard',
     activity_day:e.date
   })).filter(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.activity_day)).slice(-1000);
   if(activities.length){const {error}=await api.from('speakwise_activity').upsert(activities,{onConflict:'id'});if(error)throw error;}
   const deletedMistakes=[...new Set(st.deletedMistakeIds||[])].slice(-400);
   if(deletedMistakes.length){
     const {error}=await api.from('speakwise_mistakes').delete().eq('user_id',user.id).in('id',deletedMistakes);
     if(error)throw error;
   }
   const mistakes=(st.mistakes||[]).filter(m=>!deletedMistakes.includes(m.id)).map(m=>({
      id:m.id,user_id:user.id,
      entry_id:st.entries.some(e=>e.id===m.entryId)?m.entryId:null,
      mode:m.mode==='speak'?'speak':'write',
      original_text:String(m.originalText||'').slice(0,2000),
      suggested_revision:String(m.revisedText||'').slice(0,2000),
      note:String(m.note||'').slice(0,1200),
      status:m.status==='resolved'?'resolved':'open',
      updated_at:m.updatedAt||m.createdAt||new Date().toISOString()
   })).filter(m=>m.id&&m.original_text).slice(0,400);
   if(mistakes.length){const {error}=await api.from('speakwise_mistakes').upsert(mistakes,{onConflict:'id'});if(error)throw error;}
   const preferences={user_id:user.id,data:{
     settings:st.settings||{},lastPractice:st.lastPractice||null,learningJourney:st.learningJourney||null,
     deletedMistakeIds:[...new Set(st.deletedMistakeIds||[])].slice(-400)
   }};
   const prefResult=await api.from('speakwise_preferences').upsert(preferences,{onConflict:'user_id'});
   if(prefResult.error)throw prefResult.error;
   const hidden=[...new Set(st.deletedIds||[])].map(entry_id=>({user_id:user.id,entry_id}));
   if(hidden.length){const {error}=await api.from('speakwise_hidden').upsert(hidden,{onConflict:'user_id,entry_id'});if(error)throw error;}
   label('Tài khoản');
  }catch(e){label('Tài khoản');tell('Không đồng bộ được, nhưng vẫn đã lưu cục bộ: '+(e.message||String(e)))}finally{writing=false}
 }
 function scheduleSave(){if(!enabled()||loading)return;clearTimeout(timer);timer=setTimeout(push,1200)}
 async function init(context){
  ctx=context;
  $('syncButton')?.addEventListener('click',dialog);
  setGate(true);
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!window.supabase?.createClient){
   showDialog(true);
   $('swSyncMessage').textContent='Không thể mở website vì hệ thống đăng nhập chưa sẵn sàng.';
   $('swSyncControls').innerHTML='<p class="sw-sync-error">Thiếu cấu hình Supabase hoặc không tải được thư viện xác thực. Vui lòng kiểm tra config.js và kết nối mạng.</p>';
   $('swSyncClose').hidden=true;return;
  }
  api=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);
  let sessionResult;
  try{sessionResult=await api.auth.getSession();}
  catch(e){sessionResult={error:e};}
  if(sessionResult.error){
   showDialog(true);
   $('swSyncMessage').textContent='Không kiểm tra được trạng thái đăng nhập.';
   $('swSyncControls').innerHTML='<p class="sw-sync-error">'+String(sessionResult.error.message||'Lỗi xác thực')+'</p><button class="btn btn-primary sw-sync-submit" id="swSyncRetry">Thử lại</button>';
   $('swSyncClose').hidden=true;$('swSyncRetry').onclick=()=>location.reload();return;
  }
  user=sessionResult.data?.session?.user||null;
  setGate(!user);
  if(user){label('Tài khoản');await load();scheduleSave();}
  else{label('Đăng nhập');showDialog(true);}
  api.auth.onAuthStateChange((event,session)=>{
   const was=user?.id;user=session?.user||null;
   if(user){
    setGate(false);label('Tài khoản');
    if(user.id!==was){const host=$('speakwiseSyncHost');if(host)host.classList.remove('open');load().then(scheduleSave);}
   }else{
    setGate(true);label('Đăng nhập');showDialog(true);
   }
  });
 }
 window.SpeakwiseSync={init,scheduleSave};
})();