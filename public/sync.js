/* Optional Speakwise Supabase sync. Safe local-first fallback. */
(() => {
 'use strict';
 const cfg=window.SPEAKWISE_CONFIG||{};
 let api=null,user=null,ctx=null,timer=null,writing=false,loading=false;
 const $=id=>document.getElementById(id);
 const tell=msg=>ctx?.toast?.(msg);
 const label=msg=>{const el=$('syncButton');if(el)el.textContent=msg;};
 const enabled=()=>!!(api&&user&&ctx);
 function dialog(){
  let host=$('speakwiseSyncHost');
  if(!host){host=document.createElement('div');host.id='speakwiseSyncHost';document.body.append(host);}
  host.innerHTML='<div class="sw-sync-shade"></div><div class="sw-sync-modal" role="dialog" aria-modal="true"><button id="swSyncClose" type="button" class="sw-sync-close" aria-label="Đóng">×</button><h2>Đồng bộ Speakwise</h2><p id="swSyncMessage"></p><div id="swSyncControls"></div><small>Dữ liệu riêng tư cần Supabase Row Level Security. Không sử dụng service_role key trên trình duyệt.</small></div>';
  host.classList.add('open');
  host.querySelector('.sw-sync-shade').addEventListener('click',()=>host.classList.remove('open'));
  $('swSyncClose').addEventListener('click',()=>host.classList.remove('open'));
  const message=$('swSyncMessage'),body=$('swSyncControls');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){message.textContent='Website hiện lưu dữ liệu trên thiết bị; chưa có dự án Supabase riêng.';return;}
  if(!api){message.textContent='Chưa kết nối được Supabase. Kiểm tra config.js và đường truyền.';return;}
  if(!user){
   message.textContent='Đăng nhập bằng liên kết email để đồng bộ tiến độ.';
   body.innerHTML='<label>Email <input id="swSyncEmail" type="email" autocomplete="email" placeholder="email@example.com"/></label><button type="button" class="btn btn-primary" id="swSyncLogin">Gửi liên kết đăng nhập</button>';
   $('swSyncLogin').addEventListener('click',async()=>{
    const email=$('swSyncEmail').value.trim();
    if(!/^\S+@\S+\.\S+$/.test(email)){tell('Hãy nhập email hợp lệ.');return}
    const {error}=await api.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
    tell(error?'Lỗi gửi email: '+error.message:'Đã gửi liên kết đăng nhập qua email.');
   });
  }else{
   message.textContent='Đã đăng nhập: '+(user.email||'Supabase user');
   body.innerHTML='<button type="button" class="btn btn-primary" id="swSyncNow">Đồng bộ ngay</button> <button type="button" class="btn btn-muted" id="swSyncLogout">Đăng xuất</button>';
   $('swSyncNow').onclick=async()=>{await load();await push()};
   $('swSyncLogout').onclick=async()=>{await api.auth.signOut();user=null;label('Đồng bộ');host.classList.remove('open');tell('Đã đăng xuất; bản sao dữ liệu trên thiết bị vẫn còn.')};
  }
 }
 async function load(){
  if(!enabled()||loading)return;loading=true;label('Đang đồng bộ…');
  try{
   const [topics,ents,progs,hiddens,activities]=await Promise.all([
    api.from('speakwise_topics').select('*'),
    api.from('speakwise_entries').select('*'),
    api.from('speakwise_progress').select('*').eq('user_id',user.id),
    api.from('speakwise_hidden').select('entry_id').eq('user_id',user.id),
    api.from('speakwise_activity').select('*').eq('user_id',user.id).order('occurred_at',{ascending:false}).limit(1000)
   ]);
   for(const r of [topics,ents,progs,hiddens,activities])if(r.error)throw r.error;
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
    if(!old.updatedAt||old.updatedAt<=row.updated_at)st.progress[row.entry_id]={...old,level:row.level,reviews:row.reviews,nextReview:row.next_review,starred:row.starred,updatedAt:row.updated_at};
   }
   const known=new Set((st.reviewEvents||[]).map(e=>e.id));
   for(const row of activities.data||[]){
     const e={id:row.id,date:row.activity_day,entryId:row.entry_id,action:row.action,rating:'synced'};
     if(!known.has(e.id)){st.reviewEvents.push(e);known.add(e.id)}
   }
   st.activityDates=[...new Set([...(st.activityDates||[]),...(activities.data||[]).map(x=>x.activity_day).filter(Boolean)])];
   st.reviewEvents=st.reviewEvents.slice(-3000);
   st.deletedIds=[...new Set([...(st.deletedIds||[]),...(hiddens.data||[]).map(x=>x.entry_id)])];
   st.entries=st.entries.filter(x=>!st.deletedIds.includes(x.id));
   try{localStorage.setItem('speakwise-collocation-studio-v1',JSON.stringify(st))}catch(_){}
   ctx.render();label('Đã đồng bộ');
  }catch(e){label('Đồng bộ lỗi');tell(e.message||String(e))}finally{loading=false}
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
   const progress=Object.entries(st.progress).map(([entry_id,p])=>({user_id:user.id,entry_id,level:Math.max(0,Math.min(5,Number(p.level)||0)),reviews:Number(p.reviews)||0,next_review:p.nextReview||null,starred:!!p.starred}));
   if(progress.length){const {error}=await api.from('speakwise_progress').upsert(progress,{onConflict:'user_id,entry_id'});if(error)throw error;}
   const activities=(st.reviewEvents||[]).map((e,i)=>({
     id:e.id||('legacy-'+e.date+'-'+e.entryId+'-'+i),
     user_id:user.id,entry_id:st.entries.some(x=>x.id===e.entryId)?e.entryId:null,
     action:['flashcard','mcq','recall','write','speak'].includes(e.action)?e.action:'flashcard',
     activity_day:e.date
   })).filter(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.activity_day)).slice(-1000);
   if(activities.length){const {error}=await api.from('speakwise_activity').upsert(activities,{onConflict:'id'});if(error)throw error;}
   const hidden=[...new Set(st.deletedIds||[])].map(entry_id=>({user_id:user.id,entry_id}));
   if(hidden.length){const {error}=await api.from('speakwise_hidden').upsert(hidden,{onConflict:'user_id,entry_id'});if(error)throw error;}
   label('Đã đồng bộ');
  }catch(e){label('Đồng bộ lỗi');tell('Không đồng bộ được, nhưng vẫn đã lưu cục bộ: '+(e.message||String(e)))}finally{writing=false}
 }
 function scheduleSave(){if(!enabled()||loading)return;clearTimeout(timer);timer=setTimeout(push,1200)}
 async function init(context){
  ctx=context;
  $('syncButton')?.addEventListener('click',dialog);
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){label('Lưu cục bộ');return}
  if(!window.supabase?.createClient){label('Thiếu Supabase SDK');return}
  api=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);
  const {data,error}=await api.auth.getSession();
  if(error){tell(error.message);return;}
  user=data?.session?.user||null;
  if(user){await load();scheduleSave()}else label('Đồng bộ');
  api.auth.onAuthStateChange((event,session)=>{
   const was=user?.id;user=session?.user||null;
   if(user&&user.id!==was){load().then(scheduleSave)}
   else if(!user)label('Đồng bộ');
  });
 }
 window.SpeakwiseSync={init,scheduleSave};
})();