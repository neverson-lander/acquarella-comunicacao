export function bindSearchEnter(input,action){
 input.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.isComposing||event.keyCode===229)return;
  event.preventDefault();event.stopPropagation();
  if(event.repeat)return;
  if(typeof action==='function')action();
  else if(!action.disabled)action.click();
 });
}
