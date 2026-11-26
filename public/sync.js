/* Optional Speakwise Supabase sync. Safe local-first fallback. */
(() => {
 'use strict';
 const cfg=window.SPEAKWISE_CONFIG||{};
 let api=null,user=null,ctx=null,timer=null,writing=false,loading=false;
 const $=id=>document.getElementById(id);
 const tell=msg=>ctx?.toast?.(msg);
 let menuOpen=false,customAvatar=null;
 const enabled=()=>!!(api&&user&&ctx);
 function setGate(locked){
  document.documentElement.classList.toggle('sw-auth-required',!!locked);
  document.documentElement.classList.remove('sw-auth-pending');
 }
 const LOGO_SRC='/speakwise-logo.webp';
 const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const svg=(paths,size=20)=>'<svg viewBox="0 0 24 24" width="'+size+'" height="'+size+'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths+'</svg>';
 const ICON={
  eye:svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:svg('<path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-6.4 0-10-7-10-7a18.7 18.7 0 0 1 4.2-5.1M9.9 5.2A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/>'),
  camera:svg('<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>'),
  pencil:svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  sync:svg('<path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/><path d="M16 16h5v5"/>'),
  trash:svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  logout:svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
  google:'<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>'
 };
 const displayName=u=>{const m=(u&&u.user_metadata)||{};const n=String(m.display_name||m.full_name||m.name||'').trim();return n||String((u&&u.email)||'').split('@')[0]||'Tài khoản'};
 const initials=n=>{const t=String(n||'').trim();return t?Array.from(t)[0].toLocaleUpperCase():'?'};
 const avatarKey=id=>'speakwise-avatar-'+id;
 const validAvatar=a=>!!(a&&typeof a.dataUrl==='string'&&a.dataUrl.length<60000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(a.dataUrl));
 const loadAvatarLocal=()=>{customAvatar=null;if(!user)return;try{const raw=localStorage.getItem(avatarKey(user.id));const a=raw?JSON.parse(raw):null;if(a&&(a.dataUrl===null||validAvatar(a)))customAvatar=a}catch(_){customAvatar=null}};
 const saveAvatarLocal=()=>{if(!user)return;try{if(customAvatar)localStorage.setItem(avatarKey(user.id),JSON.stringify(customAvatar));else localStorage.removeItem(avatarKey(user.id))}catch(_){tell('Không lưu được ảnh trên thiết bị này.')}};
 const avatarSrc=()=>validAvatar(customAvatar)?customAvatar.dataUrl:String((user&&user.user_metadata&&(user.user_metadata.avatar_url||user.user_metadata.picture))||'');
 function avatarHtml(cls){
  const src=avatarSrc(),letter=esc(initials(displayName(user)));
  return '<span class="sw-avatar '+(cls||'')+'">'+(src?'<img src="'+esc(src)+'" alt="" referrerpolicy="no-referrer" data-letter="'+letter+'">':'<span class="sw-avatar-letter">'+letter+'</span>')+'</span>';
 }
 function fixBrokenAvatars(root){
  root.querySelectorAll('.sw-avatar img').forEach(img=>img.addEventListener('error',()=>{const f=document.createElement('span');f.className='sw-avatar-letter';f.textContent=img.dataset.letter||'?';img.replaceWith(f)},{once:true}));
 }
 function label(){
  const el=$('syncButton');if(!el)return;
  if(user){
   el.classList.add('is-profile');el.setAttribute('aria-haspopup','menu');el.setAttribute('aria-expanded',menuOpen?'true':'false');
   el.setAttribute('aria-label','Tài khoản: '+displayName(user));
   el.innerHTML=avatarHtml('sw-avatar-sm')+'<span class="sw-account-name">'+esc(displayName(user))+'</span>'+svg('<path d="m6 15 6-6 6 6"/>',18).replace('<svg ','<svg class="sw-account-caret" ');
   fixBrokenAvatars(el);
  }else{
   closeMenu(true);
   el.classList.remove('is-profile');el.removeAttribute('aria-haspopup');el.removeAttribute('aria-expanded');
   el.setAttribute('aria-label','Đăng nhập hoặc mở tài khoản');el.textContent='Đăng nhập';
  }
 }
 const authShell=inner=>'<div class="sw-auth-page"><div class="sw-auth-card" role="dialog" aria-modal="true" aria-labelledby="swSyncTitle"><button id="swSyncClose" type="button" class="sw-sync-close" aria-label="Đóng">×</button><div class="sw-auth-logo"><img src="'+LOGO_SRC+'" alt="SpeakWise"><div><strong>Speakwise<span>.</span></strong><small>COLLOCATION STUDIO</small></div></div>'+inner+'<small class="sw-auth-foot">Tài khoản được xác thực và bảo vệ bởi Supabase Authentication.</small></div></div>';
 function showDialog(required=false){
  if(user){openMenu('main');return;}
  let host=$('speakwiseSyncHost');
  if(!host){host=document.createElement('div');host.id='speakwiseSyncHost';document.body.append(host);}
  host.dataset.required=required?'1':'0';
  host.innerHTML=authShell('<h2 id="swSyncTitle">Chào mừng trở lại</h2><p id="swSyncMessage" class="sw-auth-sub"></p><div id="swSyncControls"></div>');
  host.classList.add('open');
  const close=()=>{if(host.dataset.required!=='1')host.classList.remove('open')};
  $('swSyncClose').addEventListener('click',close);
  const message=$('swSyncMessage'),body=$('swSyncControls'),title=$('swSyncTitle');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){
   title.textContent='Dịch vụ tài khoản chưa sẵn sàng';
   message.textContent='Dịch vụ tài khoản chưa được cấu hình.';
   body.innerHTML='<p class="sw-sync-error">Thiếu Supabase URL hoặc publishable key trong config.js.</p>';
   $('swSyncClose').hidden=required;return;
  }
  if(!api){message.textContent='Đang kết nối dịch vụ tài khoản…';body.innerHTML='<p class="sw-auth-sub">Vui lòng chờ trong giây lát.</p>';$('swSyncClose').hidden=required;return;}
  $('swSyncClose').hidden=required;
  const renderForm=(mode='login')=>{
   const isRegister=mode==='register';
   title.textContent=isRegister?'Tạo tài khoản':'Chào mừng trở lại';
   message.textContent=isRegister?'Tạo tài khoản SpeakWise bằng email và mật khẩu.':'Đăng nhập để tiếp tục học và đồng bộ tiến độ của bạn.';
   body.innerHTML=
    '<form id="swAuthForm" class="sw-auth-form" novalidate>'+
     '<label for="swAuthEmail">Email</label>'+
     '<input id="swAuthEmail" type="email" autocomplete="email" placeholder="name@example.com" required/>'+
     '<label for="swAuthPassword">Mật khẩu</label>'+
     '<div class="sw-pass-wrap"><input id="swAuthPassword" type="password" autocomplete="'+(isRegister?'new-password':'current-password')+'" placeholder="Nhập mật khẩu" required/><button type="button" class="sw-pass-toggle" id="swPassToggle" aria-label="Hiện mật khẩu">'+ICON.eye+'</button></div>'+
     (isRegister?'<label for="swAuthConfirm">Xác nhận mật khẩu</label><input id="swAuthConfirm" type="password" autocomplete="new-password" placeholder="Nhập lại mật khẩu"/>':'<div class="sw-auth-row"><button type="button" class="sw-auth-forgot" id="swAuthForgot">Quên mật khẩu?</button></div>')+
     '<p class="sw-sync-error" id="swAuthError" role="alert" hidden></p>'+
     '<button type="submit" class="sw-auth-submit" id="swAuthSubmit">'+(isRegister?'Tạo tài khoản':'Đăng nhập')+'</button>'+
    '</form>'+
    '<div class="sw-auth-divider"><span>hoặc</span></div>'+
    '<button type="button" id="swGoogleLogin" class="sw-google-btn">'+ICON.google+'<span>Tiếp tục với Google</span></button>'+
    '<p class="sw-auth-switch">'+(isRegister?'Đã có tài khoản? <button type="button" class="sw-auth-link" id="swTabLogin">Đăng nhập</button>':'Chưa có tài khoản? <button type="button" class="sw-auth-link" id="swTabRegister">Đăng ký</button>')+'</p>';
   const toggle=$('swPassToggle');
   toggle.onclick=()=>{const input=$('swAuthPassword');const show=input.type==='password';input.type=show?'text':'password';toggle.innerHTML=show?ICON.eyeOff:ICON.eye;toggle.setAttribute('aria-label',show?'Ẩn mật khẩu':'Hiện mật khẩu')};
   $('swGoogleLogin').onclick=async()=>{
    const button=$('swGoogleLogin'),err=$('swAuthError');
    button.disabled=true;button.querySelector('span').textContent='Đang chuyển đến Google…';
    if(err){err.hidden=true;err.textContent='';}
    try{
     const {error}=await api.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+location.pathname+location.search}});
     if(error)throw error;
    }catch(ex){
     if(err){err.textContent=ex.message||'Không thể đăng nhập bằng Google. Vui lòng thử lại.';err.hidden=false;}
     button.disabled=false;button.querySelector('span').textContent='Tiếp tục với Google';
    }
   };
   const goLogin=$('swTabLogin'),goRegister=$('swTabRegister');
   if(goLogin)goLogin.onclick=()=>renderForm('login');
   if(goRegister)goRegister.onclick=()=>renderForm('register');
   const forgot=$('swAuthForgot');
   if(forgot)forgot.onclick=async()=>{
    const email=$('swAuthEmail').value.trim(),err=$('swAuthError');err.hidden=true;
    if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Nhập email của bạn trước khi yêu cầu đặt lại mật khẩu.';err.hidden=false;return;}
    try{
     const {error}=await api.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
     if(error)throw error;
     title.textContent='Kiểm tra email của bạn';
     message.textContent='Đã gửi email đặt lại mật khẩu. Hãy kiểm tra hộp thư đến và thư mục Spam.';
     body.innerHTML='<p class="sw-sync-login-note">Mở liên kết trong email để tiếp tục đặt lại mật khẩu.</p><button type="button" class="sw-auth-submit sw-auth-secondary" id="swAuthBack">Quay lại đăng nhập</button>';
     $('swAuthBack').onclick=()=>renderForm('login');
    }catch(e){err.textContent=e.message||'Không gửi được email đặt lại mật khẩu.';err.hidden=false;}
   };
   $('swAuthForm').onsubmit=async e=>{
    e.preventDefault();
    const email=$('swAuthEmail').value.trim(),password=$('swAuthPassword').value,confirm=($('swAuthConfirm')&&$('swAuthConfirm').value)||'';
    const err=$('swAuthError'),button=$('swAuthSubmit');err.hidden=true;err.textContent='';
    if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Vui lòng nhập email hợp lệ.';err.hidden=false;return;}
    if(password.length<8){err.textContent='Mật khẩu cần có ít nhất 8 ký tự.';err.hidden=false;return;}
    if(isRegister&&password!==confirm){err.textContent='Mật khẩu xác nhận không khớp.';err.hidden=false;return;}
    button.disabled=true;button.textContent=isRegister?'Đang tạo tài khoản…':'Đang đăng nhập…';
    try{
     if(isRegister){
      const {data,error}=await api.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});
      if(error)throw error;
      if(data&&data.session){user=data.user;loadAvatarLocal();setGate(false);label();host.classList.remove('open');await load();scheduleSave();}
      else{
       title.textContent='Kiểm tra email của bạn';
       message.textContent='Nếu email này chưa có tài khoản, hãy kiểm tra hộp thư để xác nhận. Nếu bạn đã đăng ký trước đó, hãy chuyển sang đăng nhập hoặc đặt lại mật khẩu.';
       body.innerHTML='<p class="sw-sync-login-note">Lưu ý: đăng ký lại bằng một email đã tồn tại không thay đổi mật khẩu cũ. Nếu không nhớ mật khẩu, chọn “Quên mật khẩu?” ở màn hình đăng nhập.</p><button type="button" class="sw-auth-submit" id="swAuthReturn">Chuyển sang đăng nhập</button>';
       $('swAuthReturn').onclick=()=>renderForm('login');
      }
     }else{
      const {data,error}=await api.auth.signInWithPassword({email,password});
      if(error)throw error;
      user=data.user;loadAvatarLocal();setGate(false);label();host.classList.remove('open');await load();scheduleSave();
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
 }
 // ---------- account menu (bottom-left profile chip) ----------
 function onMenuOutside(e){const m=$('swAccountMenu');if(!m)return;const chip=$('syncButton');if(m.contains(e.target)||(chip&&chip.contains(e.target)))return;closeMenu();}
 function onMenuKey(e){if(e.key==='Escape'){closeMenu();const chip=$('syncButton');if(chip)chip.focus();}}
 function closeMenu(silent){
  const m=$('swAccountMenu');if(m)m.remove();
  document.removeEventListener('pointerdown',onMenuOutside,true);document.removeEventListener('keydown',onMenuKey,true);
  if(menuOpen){menuOpen=false;if(!silent)label();}
 }
 function resizeToSquare(file,size){
  return new Promise((resolve,reject)=>{
   const url=URL.createObjectURL(file),img=new Image();
   img.onload=()=>{
    try{
     const side=Math.min(img.naturalWidth,img.naturalHeight);
     const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
     const g=canvas.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,size,size);
     g.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,size,size);
     URL.revokeObjectURL(url);resolve(canvas.toDataURL('image/jpeg',0.85));
    }catch(e){URL.revokeObjectURL(url);reject(e);}
   };
   img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('bad image'));};
   img.src=url;
  });
 }
 async function changeAvatar(file){
  if(!file)return;
  if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){tell('Vui lòng chọn ảnh PNG, JPG hoặc WebP.');return;}
  if(file.size>8*1024*1024){tell('Ảnh quá lớn. Vui lòng chọn ảnh dưới 8 MB.');return;}
  try{
   const dataUrl=await resizeToSquare(file,192);
   if(!validAvatar({dataUrl}))throw new Error('too large');
   customAvatar={dataUrl,updatedAt:new Date().toISOString()};
   saveAvatarLocal();label();if($('swAccountMenu'))openMenu('main');
   tell('Đã cập nhật ảnh đại diện.');scheduleSave();
  }catch(_){tell('Không đọc được ảnh này. Hãy thử một ảnh khác.');}
 }
 function removeAvatar(){
  customAvatar={dataUrl:null,updatedAt:new Date().toISOString()};
  saveAvatarLocal();label();openMenu('main');tell('Đã xóa ảnh tùy chỉnh.');scheduleSave();
 }
 function openMenu(view='main'){
  if(!user)return;
  let m=$('swAccountMenu');
  if(!m){m=document.createElement('div');m.id='swAccountMenu';m.className='sw-account-menu';m.setAttribute('role','menu');document.body.append(m);document.addEventListener('pointerdown',onMenuOutside,true);document.addEventListener('keydown',onMenuKey,true);}
  menuOpen=true;label();
  const chip=$('syncButton');
  if(chip){const r=chip.getBoundingClientRect();m.style.left=Math.max(12,Math.round(r.left))+'px';m.style.bottom=Math.round(window.innerHeight-r.top+10)+'px';m.style.width=Math.max(290,Math.round(r.width))+'px';}
  const name=displayName(user);
  const head='<div class="sw-menu-head">'+avatarHtml('sw-avatar-lg')+'<div class="sw-menu-id"><strong>'+esc(name)+'</strong><span>'+esc(user.email||'')+'</span></div></div>';
  if(view==='rename'){
   m.innerHTML=head+'<form class="sw-menu-form" id="swRenameForm" novalidate><label for="swRenameInput">Tên hiển thị</label><input id="swRenameInput" maxlength="40" autocomplete="nickname" value="'+esc(name)+'"/><p class="sw-menu-error" id="swRenameError" role="alert" hidden></p><div class="sw-menu-actions"><button type="submit" class="sw-menu-primary" id="swRenameSave">Lưu</button><button type="button" class="sw-menu-secondary" id="swRenameCancel">Hủy</button></div></form>';
   fixBrokenAvatars(m);
   const input=$('swRenameInput');input.focus();input.select();
   $('swRenameCancel').onclick=()=>openMenu('main');
   $('swRenameForm').onsubmit=async e=>{
    e.preventDefault();
    const err=$('swRenameError'),save=$('swRenameSave');
    const value=input.value.replace(/\s+/g,' ').trim().slice(0,40);
    err.hidden=true;
    if(!value){err.textContent='Tên hiển thị không được để trống.';err.hidden=false;return;}
    save.disabled=true;save.textContent='Đang lưu…';
    try{
     const {data,error}=await api.auth.updateUser({data:{display_name:value}});
     if(error)throw error;
     if(data&&data.user)user=data.user;
     label();tell('Đã đổi tên hiển thị.');openMenu('main');
    }catch(ex){err.textContent=ex.message||'Không đổi được tên. Vui lòng thử lại.';err.hidden=false;save.disabled=false;save.textContent='Lưu';}
   };
   return;
  }
  m.innerHTML=head+
   '<div class="sw-menu-list">'+
    '<button type="button" class="sw-menu-item" id="swMenuAvatar" role="menuitem">'+ICON.camera+'<span>Thay đổi ảnh đại diện</span></button>'+
    (validAvatar(customAvatar)?'<button type="button" class="sw-menu-item" id="swMenuRemoveAvatar" role="menuitem">'+ICON.trash+'<span>Xóa ảnh tùy chỉnh</span></button>':'')+
    '<button type="button" class="sw-menu-item" id="swMenuRename" role="menuitem">'+ICON.pencil+'<span>Đổi tên hiển thị</span></button>'+
    '<button type="button" class="sw-menu-item" id="swMenuSync" role="menuitem">'+ICON.sync+'<span>Đồng bộ ngay</span></button>'+
   '</div><div class="sw-menu-sep"></div>'+
   '<button type="button" class="sw-menu-item danger" id="swMenuLogout" role="menuitem">'+ICON.logout+'<span>Đăng xuất</span></button>'+
   '<input type="file" id="swAvatarFile" accept="image/png,image/jpeg,image/webp" hidden>';
  fixBrokenAvatars(m);
  $('swMenuAvatar').onclick=()=>$('swAvatarFile').click();
  $('swAvatarFile').onchange=async e=>{const f=e.target.files&&e.target.files[0];e.target.value='';await changeAvatar(f);};
  const removeBtn=$('swMenuRemoveAvatar');if(removeBtn)removeBtn.onclick=removeAvatar;
  $('swMenuRename').onclick=()=>openMenu('rename');
  $('swMenuSync').onclick=async()=>{closeMenu();await load();await push();};
  $('swMenuLogout').onclick=async()=>{
   const {error}=await api.auth.signOut();
   if(error){tell(error.message);return;}
   closeMenu(true);user=null;customAvatar=null;setGate(true);label();showDialog(true);tell('Bạn đã đăng xuất.');
  };
 }
 function showPasswordRecovery(){
  let host=$('speakwiseSyncHost');
  if(!host){host=document.createElement('div');host.id='speakwiseSyncHost';document.body.append(host);}
  host.dataset.required='1';
  host.innerHTML=authShell('<h2 id="swSyncTitle">Đặt mật khẩu mới</h2><p class="sw-auth-sub">Nhập mật khẩu mới cho tài khoản SpeakWise của bạn.</p><form id="swRecoveryForm" class="sw-auth-form" novalidate><label for="swNewPassword">Mật khẩu mới</label><input id="swNewPassword" type="password" autocomplete="new-password" required/><label for="swNewPasswordConfirm">Xác nhận mật khẩu</label><input id="swNewPasswordConfirm" type="password" autocomplete="new-password" required/><p class="sw-sync-error" id="swRecoveryError" role="alert" hidden></p><button type="submit" class="sw-auth-submit" id="swRecoverySubmit">Lưu mật khẩu mới</button></form>');
  $('swSyncClose').hidden=true;
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
    user=data.user;loadAvatarLocal();setGate(false);label();host.classList.remove('open');tell('Đã cập nhật mật khẩu thành công.');await load();scheduleSave();
   }catch(ex){err.textContent=ex.message||'Không cập nhật được mật khẩu.';err.hidden=false;btn.disabled=false;btn.textContent='Lưu mật khẩu mới';}
  };
 }
 function dialog(){if(user){if($('swAccountMenu'))closeMenu();else openMenu('main');}else showDialog(false);}
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
     // Profile picture: the most recently changed one wins (a removal is a record with dataUrl null).
     const remoteAvatar=rem.profile&&rem.profile.avatar;
     if(remoteAvatar&&typeof remoteAvatar==='object'&&(remoteAvatar.dataUrl===null||validAvatar(remoteAvatar))){
       if(!customAvatar||String(customAvatar.updatedAt||'')<String(remoteAvatar.updatedAt||'')){customAvatar={dataUrl:remoteAvatar.dataUrl,updatedAt:remoteAvatar.updatedAt||new Date(0).toISOString()};saveAvatarLocal();}
     }
     label();
   }
   st.activityDates=[...new Set([...(st.activityDates||[]),...(activities.data||[]).map(x=>x.activity_day).filter(Boolean)])];
   st.reviewEvents=st.reviewEvents.slice(-3000);
   st.deletedIds=[...new Set([...(st.deletedIds||[]),...(hiddens.data||[]).map(x=>x.entry_id)])];
   st.entries=st.entries.filter(x=>!st.deletedIds.includes(x.id));
   try{localStorage.setItem('speakwise-collocation-studio-v1',JSON.stringify(st))}catch(_){}
   ctx.render();label('Tài khoản');
  }catch(e){label('Tài khoản');tell(e.message||String(e))}finally{loading=false}
 }
 // Topics and entries that live in the database without an owner (owner_id is null) are shared content.
 // The browser may download them, but only their owner can change a row, so they must never be written back.
 async function withoutSharedRows(table,rows){
  if(!rows.length)return rows;
  const shared=new Set();
  const ids=rows.map(r=>r.id);
  for(let i=0;i<ids.length;i+=150){
   const {data,error}=await api.from(table).select('id').in('id',ids.slice(i,i+150)).is('owner_id',null);
   if(error)throw error;
   for(const r of data||[])shared.add(r.id);
  }
  return rows.filter(r=>!shared.has(r.id));
 }
 async function push(){
  if(!enabled()||loading||writing)return;
  writing=true;
  try{
   const st=ctx.store,baseIds=new Set((window.SPEAKING_SEED?.entries||[]).map(x=>x.id));
   const baseTopicIds=new Set((window.SPEAKING_SEED?.topics||[]).map(x=>x.id));
   const customTopicsAll=st.topics.filter(t=>!baseTopicIds.has(t.id)).map(t=>({
     id:t.id,owner_id:user.id,name:t.name,vi:t.vi||t.name,section:t.section||'life',
     icon:t.icon||'book',description:t.desc||''
   }));
   const customTopics=await withoutSharedRows('speakwise_topics',customTopicsAll);
   if(customTopics.length){const {error}=await api.from('speakwise_topics').upsert(customTopics,{onConflict:'id'});if(error)throw error;}
   const entriesAll=st.entries.filter(e=>!baseIds.has(e.id)).map(e=>({id:e.id,owner_id:user.id,topic_id:e.topicId,phrase:e.phrase,ipa:e.ipa||'',meaning:e.meaning,example:e.example,note:e.note||'',source:e.source||'',added_at:e.addedAt||new Date().toISOString().slice(0,10)}));
   const entries=await withoutSharedRows('speakwise_entries',entriesAll);
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
     profile:{avatar:(customAvatar&&(customAvatar.dataUrl===null||validAvatar(customAvatar)))?customAvatar:null},
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
    if(user.id!==previousId)loadAvatarLocal();
    label();
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