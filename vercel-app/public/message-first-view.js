// Only messages intersecting the viewport in an active, visible window count.
// The server chooses the timestamp and atomically preserves the first viewer.
export function createFirstViewTracker({api,onRecorded}){
  let observer=null,timer=null,generation=0,active=null,busy=false;
  const visible=new Set();
  const schedule=(delay=100)=>{clearTimeout(timer);timer=setTimeout(flush,delay);};
  const ready=()=>active?.root.isConnected&&document.visibilityState==='visible'&&document.hasFocus();
  async function flush(){
    if(!ready()||busy)return;
    const batch=[...visible].filter(node=>node.isConnected).slice(0,100);
    if(!batch.length)return;
    const current=active,version=generation;busy=true;
    try{
      const result=await api(`conversations/${current.conversation}/messages/first-view`,{ids:batch.map(node=>node.dataset.messageId)});
      if(version!==generation)return;
      const confirmed=new Set(result.messages.filter(m=>m.first_viewed_at).map(m=>m.id));
      for(const node of batch)if(confirmed.has(node.dataset.messageId)){visible.delete(node);observer?.unobserve(node);}
      onRecorded(current.conversation,result.messages);
    }catch{
      // A failed request must not create a local or invented view timestamp.
    }finally{
      busy=false;
      if(ready()&&visible.size)schedule(5000);
    }
  }
  document.addEventListener('visibilitychange',()=>{if(ready())schedule();});
  window.addEventListener('focus',()=>schedule());
  return {bind(root,conversation,identity){
    generation++;clearTimeout(timer);observer?.disconnect();visible.clear();
    active={root,conversation:conversation.id,identity};
    const unknown=new Set(conversation.messages.filter(m=>m.direction==='in'&&!m.first_viewed_at).map(m=>m.id));
    if(!unknown.size)return;
    observer=new IntersectionObserver(entries=>{
      for(const entry of entries){
        const enough=entry.isIntersecting&&entry.intersectionRect.width>0&&entry.intersectionRect.height>=Math.min(32,entry.boundingClientRect.height);
        if(enough)visible.add(entry.target);else visible.delete(entry.target);
      }
      if(visible.size&&ready())schedule();
    },{threshold:[0,0.01,0.1,0.25,0.5,1]});
    for(const node of root.querySelectorAll('[data-message-id]'))if(unknown.has(node.dataset.messageId))observer.observe(node);
  }};
}
