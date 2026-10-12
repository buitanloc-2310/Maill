(()=>{
 if(window.SkyFirstDialog)return;
 const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
 const show=(message,kind='info',initial='')=>new Promise(resolve=>{
  const backdrop=document.createElement('div');backdrop.className='sf-dialog-backdrop';
  const promptMode=kind==='prompt';
  backdrop.innerHTML=`<section class="sf-dialog" role="${kind==='confirm'?'alertdialog':'dialog'}" aria-modal="true"><div class="sf-dialog-mark">${kind==='confirm'?'!':'✦'}</div><h3></h3>${promptMode?'<label class="sf-dialog-input-label"><span>Giá trị</span><input id="sfDialogInput" autocomplete="off"></label>':''}<div class="sf-dialog-actions"><button type="button" class="secondary" data-cancel>Hủy</button><button type="button" class="${kind==='confirm'?'dangerbtn':'primary'}" data-ok>${kind==='confirm'?'Xác nhận':promptMode?'Tiếp tục':'Đóng'}</button></div></section>`;
  backdrop.querySelector('h3').textContent=String(message||'');
  const input=backdrop.querySelector('#sfDialogInput');if(input)input.value=initial;
  document.body.appendChild(backdrop);
  let settled=false;const done=value=>{if(settled)return;settled=true;backdrop.remove();resolve(value)};
  backdrop.querySelector('[data-cancel]').onclick=()=>done(kind==='confirm'?false:null);
  backdrop.querySelector('[data-ok]').onclick=()=>done(promptMode?input.value:kind==='confirm'?true:undefined);
  backdrop.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();done(kind==='confirm'?false:null)}else if(e.key==='Enter'&&input){e.preventDefault();done(input.value)}});
  (input||backdrop.querySelector('[data-ok]')).focus();if(input)input.select();
 });
 const notice=(message,type='info')=>{let host=document.querySelector('#sf-notice-host');if(!host){host=document.createElement('div');host.id='sf-notice-host';host.className='sf-notice-host';host.setAttribute('aria-live','polite');document.body.appendChild(host)}const item=document.createElement('div');item.className=`sf-toast ${type}`;item.textContent=String(message||'');host.appendChild(item);setTimeout(()=>item.remove(),6500)};
 window.SkyFirstDialog={confirm:message=>show(message,'confirm'),prompt:(message,initial='')=>show(message,'prompt',initial),alert:message=>notice(message,'error'),notice};
})();
