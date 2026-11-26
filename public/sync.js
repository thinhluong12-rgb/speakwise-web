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
  host.innerHTML='<div class="sw-sync-shade"></div><div class="sw-sync-modal" role="dialog" aria-modal="true" aria-labelledby="swSyncTitle"><button id="swSyncClose" type="button" class="sw-sync-close" aria-label="Đóng">×</button><h2 id="swSyncTitle">Tài khoản SpeakWise</h2><p id="swSyncMessage"></p><div id="swSyncControls"></div><div class="sw-sync-login-note">Đăng nhập hoặc tạo tài khoản để truy cập SpeakWise, sử dụng Speaking Lab và đồng bộ tiến độ học tập.</div><small>Tài khoản được xác thực và bảo vệ bởi Supabase Authentication.</small></div>';
  host.classList.add('open');
  const close=()=>{if(host.dataset.required!=='1')host.classList.remove('open')};
  host.querySelector('.sw-sync-shade').addEventListener('click',close);
  $('swSyncClose').addEventListener('click',close);
  const message=$('swSyncMessage'),body=$('swSyncControls');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){
   message.textContent='Dịch vụ tài khoản chưa được cấu hình.';
   body.innerHTML='<p class="sw-sync-error">Thiếu Supabase URL hoặc publishable key trong config.js.</p>';
   $('swSyncClose').hidden=required;return;
  }
  if(!api){message.textContent='Đang kết nối dịch vụ tài khoản…';body.innerHTML='<p>Vui lòng chờ trong giây lát.</p>';return;}
  if(!user){
   $('swSyncClose').hidden=required;
   const renderForm=(mode='login')=>{
    const isRegister=mode==='register';
    message.textContent=isRegister?'Tạo tài khoản SpeakWise bằng email và mật khẩu.':'Đăng nhập bằng email và mật khẩu đã đăng ký.';
    body.innerHTML='<button type="button" id="swGoogleLogin" class="sw-google-btn"><span aria-hidden="true">G</span> Tiếp tục với Google</button><div class="sw-auth-divider"><span>hoặc tiếp tục bằng email</span></div><div class="sw-auth-tabs"><button type="button" id="swTabLogin" class="sw-auth-tab '+(!isRegister?'active':'')+'">Đăng nhập</button><button type="button" id="swTabRegister" class="sw-auth-tab '+(isRegister?'active':'')+'">Đăng ký</button></div><form id="swAuthForm" novalidate><label for="swAuthEmail">Email</label><input id="swAuthEmail" type="email" autocomplete="email" placeholder="name@example.com" required/><label for="swAuthPassword">Mật khẩu</label><input id="swAuthPassword" type="password" autocomplete="'+(isRegister?'new-password':'current-password')+'" placeholder="Nhập mật khẩu" required/><div id="swConfirmWrap" '+(isRegister?'':'hidden')+'><label for="swAuthConfirm">Xác nhận mật khẩu</label><input id="swAuthConfirm" type="password" autocomplete="new-password" placeholder="Nhập lại mật khẩu"/></div><p class="sw-sync-error" id="swAuthError" hidden></p><button type="submit" class="btn btn-primary sw-sync-submit" id="swAuthSubmit">'+(isRegister?'Tạo tài khoản':'Đăng nhập')+'</button></form><button type="button" class="sw-auth-forgot" id="swAuthForgot" '+(isRegister?'hidden':'')+'>Quên mật khẩu?</button>';
    $('swGoogleLogin').onclick=async()=>{
     const button=$('swGoogleLogin'),err=$('swAuthError');
     button.disabled=true;button.textContent='Đang chuyển đến Google…';
     if(err){err.hidden=true;err.textContent='';}
     try{
      const {error}=await api.auth.signInWithOAuth({
       provider:'google',
       options:{redirectTo:location.origin+location.pathname+location.search}
      });
      if(error)throw error;
     }catch(ex){
      if(err){err.textContent=ex.message||'Không thể đăng nhập bằng Google. Vui lòng thử lại.';err.hidden=false;}
      button.disabled=false;button.innerHTML='<span aria-hidden="true">G</span> Tiếp tục với Google';
     }
    };
    $('swTabLogin').onclick=()=>renderForm('login');
    $('swTabRegister').onclick=()=>renderForm('register');
    $('swAuthForgot').onclick=async()=>{
     const email=$('swAuthEmail').value.trim(),err=$('swAuthError');err.hidden=true;
     if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Nhập email của bạn trước khi yêu cầu đặt lại mật khẩu.';err.hidden=false;return;}
     try{
      const {error}=await api.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
      if(error)throw error;
      message.textContent='Đã gửi email đặt lại mật khẩu. Hãy kiểm tra hộp thư đến và thư mục Spam.';
      body.innerHTML='<p class="sw-sync-login-note">Mở liên kết trong email để tiếp tục đặt lại mật khẩu.</p><button type="button" class="btn btn-muted sw-sync-submit" id="swAuthBack">Quay lại đăng nhập</button>';
      $('swAuthBack').onclick=()=>renderForm('login');
     }catch(e){err.textContent=e.message||'Không gửi được email đặt lại mật khẩu.';err.hidden=false;}
    };
    $('swAuthForm').onsubmit=async e=>{
     e.preventDefault();
     const email=$('swAuthEmail').value.trim(),password=$('swAuthPassword').value,confirm=$('swAuthConfirm')?.value||'';
     const err=$('swAuthError'),button=$('swAuthSubmit');err.hidden=true;err.textContent='';
     if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Vui lòng nhập email hợp lệ.';err.hidden=false;return;}
     if(password.length<8){err.textContent='Mật khẩu cần có ít nhất 8 ký tự.';err.hidden=false;return;}
     if(isRegister&&password!==confirm){err.textContent='Mật khẩu xác nhận không khớp.';err.hidden=false;return;}
     button.disabled=true;button.textContent=isRegister?'Đang tạo tài khoản…':'Đang đăng nhập…';
     try{
      if(isRegister){
       const {data,error}=await api.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});
       if(error)throw error;
       if(data?.session){user=data.user;setGate(false);label('Tài khoản');host.classList.remove('open');await load();scheduleSave();}
       else{
        message.textContent='Nếu email này chưa có tài khoản, hãy kiểm tra hộp thư để xác nhận. Nếu bạn đã đăng ký trước đó, hãy chuyển sang đăng nhập hoặc đặt lại mật khẩu.';
        body.innerHTML='<p class="sw-sync-login-note">Lưu ý: đăng ký lại bằng một email đã tồn tại không thay đổi mật khẩu cũ. Nếu không nhớ mật khẩu, chọn “Quên mật khẩu?” ở màn hình đăng nhập.</p><button type="button" class="btn btn-primary sw-sync-submit" id="swAuthReturn">Chuyển sang đăng nhập</button>';
        $('swAuthReturn').onclick=()=>renderForm('login');
       }
      }else{
       const {data,error}=await api.auth.signInWithPassword({email,password});
       if(error)throw error;
       user=data.user;setGate(false);label('Tài khoản');host.classList.remove('open');await load();scheduleSave();
      }
     }catch(ex){
      const raw=String(ex.message||'');
      err.textContent=(!isRegister&&/invalid login credentials/i.test(raw))
       ?'Email hoặc mật khẩu không chính xác. Nếu bạn đã đăng ký lại bằng email cũ, mật khẩu sẽ không được thay đổi. Hãy dùng mật khẩu ban đầu hoặc chọn “Quên mật khẩu?” để tạo mật khẩu mới.'
       :(raw||'Không thể xác thực tài khoản. Vui lòng thử lại.');
      err.hidden=false;button.disabled=false;button.textContent=isRegister?'Tạo tài khoản':'Đăng nhập';
     }
    };
   };
   renderForm('login');
  }else{
   message.textContent='Bạn đã đăng nhập với '+(user.email||'tài khoản SpeakWise')+'.';
   body.innerHTML='<button type="button" class="btn btn-primary sw-sync-submit" id="swSyncNow">Đồng bộ ngay</button><button type="button" class="btn btn-muted sw-sync-submit" id="swSyncLogout">Đăng xuất</button>';
   $('swSyncClose').hidden=false;
   $('swSyncNow').onclick=async()=>{await load();await push();host.classList.remove('open');};
   $('swSyncLogout').onclick=async()=>{const {error}=await api.auth.signOut();if(error){tell(error.message);return;}user=null;setGate(true);showDialog(true);label('Đăng nhập');tell('Bạn đã đăng xuất.');};
  }
 }
 function showPasswordRecovery(){
  let host=$('speakwiseSyncHost');
  if(!host){host=document.createElement('div');host.id='speakwiseSyncHost';document.body.append(host);}
  host.dataset.required='1';
  host.innerHTML='<div class="sw-sync-shade"></div><div class="sw-sync-modal" role="dialog" aria-modal="true"><h2>Đặt mật khẩu mới</h2><p>Nhập mật khẩu mới cho tài khoản SpeakWise của bạn.</p><form id="swRecoveryForm"><label for="swNewPassword">Mật khẩu mới</label><input id="swNewPassword" type="password" autocomplete="new-password" required/><label for="swNewPasswordConfirm">Xác nhận mật khẩu</label><input id="swNewPasswordConfirm" type="password" autocomplete="new-password" required/><p class="sw-sync-error" id="swRecoveryError" hidden></p><button type="submit" class="btn btn-primary sw-sync-submit" id="swRecoverySubmit">Lưu mật khẩu mới</button></form></div>';
  host.classList.add('open');
  $('swRecoveryForm').onsubmit=async e=>{
   e.preventDefault();
   const p=$('swNewPassword').value,c=$('swNewPasswordConfirm').value,err=$('swRecoveryError'),btn=$('swRecoverySubmit');
   err.hidden=true;
   if(p.length<8){err.textContent='Mật khẩu cần có ít nhất 8 ký tự.';err.hidden=false;return;}
   if(p!==c){err.textContent='Hai mật khẩu không khớp.';err.hidden=false;return;}
   btn.disabled=true;btn.textContent='Đang cập nhật…';
   try{
    const {data,error}=await api.auth.updateUser({password:p});
    if(error)throw error;
    user=data.user;setGate(false);label('Tài khoản');host.classList.remove('open');tell('Đã cập nhật mật khẩu thành công.');await load();scheduleSave();
   }catch(ex){err.textContent=ex.message||'Không cập nhật được mật khẩu.';err.hidden=false;btn.disabled=false;btn.textContent='Lưu mật khẩu mới';}
  };
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
     // Collocations the learner has used in Speaking Lab: the most recently updated record per collocation wins.
     const usedMerged={...(st.speakingUsed||{})};
     for(const [id,rec] of Object.entries(rem.speakingUsed||{})){if(!id||!rec||typeof rec!=='object')continue;const mine=usedMerged[id];if(!mine||String(mine.updatedAt||'')<String(rec.updatedAt||''))usedMerged[id]=rec}
     st.speakingUsed=usedMerged;
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
     deletedMistakeIds:[...new Set(st.deletedMistakeIds||[])].slice(-400),
     speakingUsed:Object.fromEntries(Object.entries(st.speakingUsed||{}).filter(([id,r])=>id&&r&&typeof r==='object').sort((a,b)=>String(b[1].updatedAt||'').localeCompare(String(a[1].updatedAt||''))).slice(0,1500))
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

  // Subscribe immediately: Supabase emits INITIAL_SESSION after it restores
  // local storage or exchanges the OAuth callback code.
  api=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{
   auth:{
    persistSession:true,
    autoRefreshToken:true,
    detectSessionInUrl:true,
    flowType:'pkce'
   }
  });

  api.auth.onAuthStateChange((event,session)=>{
   const previousId=user?.id||null;
   user=session?.user||null;

   if(event==='PASSWORD_RECOVERY'&&user){
    setGate(true);
    showPasswordRecovery();
    return;
   }

   if(user){
    setGate(false);
    label('Tài khoản');
    if(user.id!==previousId){
     const host=$('speakwiseSyncHost');
     if(host)host.classList.remove('open');
     // Do not call Supabase data APIs inside onAuthStateChange. Deferring
     // avoids the auth-lock deadlock documented by Supabase.
     setTimeout(()=>{load().then(scheduleSave);},0);
    }
   }else{
    setGate(true);
    label('Đăng nhập');
    if(event==='INITIAL_SESSION'||event==='SIGNED_OUT'){
     showDialog(true);
     const params=new URLSearchParams(location.search);
     const authError=params.get('error_description')||params.get('error');
     if(authError){
      $('swSyncMessage').textContent='Không thể hoàn tất đăng nhập Google: '+authError;
     }
    }
   }
  });
 }
 window.SpeakwiseSync={init,scheduleSave};
})();