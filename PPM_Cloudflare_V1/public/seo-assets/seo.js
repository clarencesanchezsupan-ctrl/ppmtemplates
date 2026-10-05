
async function ppmConfig(){
  const r=await fetch('/api/ppm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'config'})});
  const d=await r.json();
  if(!r.ok||!d||d.ok===false) throw new Error(d?.error||'Config unavailable');
  return d.result??d;
}
async function syncProductPrice(){
  const el=document.querySelector('[data-template-id]');
  if(!el)return;
  const id=el.dataset.templateId;
  try{
    const cfg=await ppmConfig();
    const t=(cfg.templates||[]).find(x=>x.id===id);
    const price=document.querySelector('[data-live-price]');
    const status=document.querySelector('[data-live-status]');
    const cta=document.querySelector('[data-store-cta]');
    if(t){
      if(price&&Number(t.price)>0) price.textContent='₱'+Number(t.price).toLocaleString('en-PH');
      if(status) status.textContent='Current PPM store listing';
    }else{
      if(status) status.textContent='Availability may have changed — view the current PPM collection.';
      if(cta){cta.textContent='Browse current templates →';cta.href='/#templatesSection';}
    }
  }catch(_){
    const status=document.querySelector('[data-live-status]');
    if(status) status.textContent='Price shown is the published page price. Open the store for the current checkout price.';
  }
}
document.addEventListener('DOMContentLoaded',syncProductPrice);
