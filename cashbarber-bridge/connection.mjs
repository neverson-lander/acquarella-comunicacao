import {cashError} from '../vercel-app/lib/cashbarber-domain.mjs';
const origin='https://painel.cashbarber.com.br';
// Browser automation is restricted to obtaining and restoring authentication.
export class CashConnection {
  constructor(browser,vault){this.browser=browser;this.vault=vault;this.contexts=new Map();this.locks=new Set();this.cache=new Map();this.requests=new WeakMap();this.crashed=new WeakSet();this.navigations=new WeakMap();}
  cached(tenant,key){const entry=this.cache.get(tenant+':'+key);if(entry&&entry.expires>Date.now())return structuredClone(entry.value);this.cache.delete(tenant+':'+key);return null;}
  remember(tenant,key,value,ttl){if(this.cache.size>=200)this.cache.delete(this.cache.keys().next().value);this.cache.set(tenant+':'+key,{value:structuredClone(value),expires:Date.now()+ttl});return value;}
  clear(tenant){for(const key of this.cache.keys())if(key.startsWith(tenant+':'))this.cache.delete(key);}
  async page(tenant){
    let context=this.contexts.get(tenant);if(context){
      const page=context.pages()[0];
      if(page&&!page.isClosed()&&!this.crashed.has(page)){
        if((this.navigations.get(page)||0)<12)return page;
        await this.vault.write('session_'+tenant,await context.storageState());
      }
      await context.close().catch(()=>{});this.contexts.delete(tenant);
    }
    const saved=await this.vault.read('session_'+tenant);
    context=await this.browser.newContext({storageState:saved||undefined,locale:'pt-BR',timezoneId:'America/Sao_Paulo',acceptDownloads:false,viewport:{width:1600,height:1000}});
    await context.route('**/*',route=>{const request=route.request();if(request.isNavigationRequest()&&request.frame()===request.frame().page().mainFrame()&&new URL(request.url()).origin!==origin)return route.abort();return route.continue();});
    context.on('page',page=>{if(context.pages().length>1)page.close().catch(()=>{});});this.contexts.set(tenant,context);
    const page=await context.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(25000);
    page.on('crash',()=>this.crashed.add(page));
    const state={pending:new Set(),changed:Date.now()};this.requests.set(page,state);
    const tracked=request=>{try{const host=new URL(request.url()).hostname;return (host==='cashbarber.com.br'||host.endsWith('.cashbarber.com.br')||host==='cashbarber.com'||host.endsWith('.cashbarber.com'))&&['document','xhr','fetch'].includes(request.resourceType());}catch{return false;}};
    page.on('request',request=>{if(tracked(request)){state.pending.add(request);state.changed=Date.now();}});
    const done=request=>{if(state.pending.delete(request))state.changed=Date.now();};page.on('requestfinished',done);page.on('requestfailed',done);return page;
  }
  async settle(page,delay=0){
    if(delay)await page.waitForTimeout(delay);const state=this.requests.get(page);if(!state)return;
    const until=Date.now()+15000;
    while(state.pending.size||Date.now()-state.changed<150){if(Date.now()>until)throw cashError('A consulta do CashBarber ainda não terminou. Tente atualizar novamente.',504);await page.waitForTimeout(50);}
  }
  async goto(page,path,authenticated=true,fresh=false){
    if(!fresh&&page.url()===origin+path&&!await page.getByRole('dialog').count()){
      if(authenticated&&page.url().includes('/auth'))throw cashError('Sessão CashBarber expirada. Peça ao administrador para conectar novamente.',409);return;
    }
    // A navigation replaces the document; outstanding requests from its old
    // document must not hold the next screen's readiness check open.
    const state=this.requests.get(page);if(state){state.pending.clear();state.changed=Date.now();}
    this.navigations.set(page,(this.navigations.get(page)||0)+1);
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'Menu do usuário',exact:true}).or(page.getByRole('button',{name:'Acessar',exact:true})).first().waitFor({timeout:25000});
    await this.settle(page);
    if(authenticated&&page.url().includes('/auth'))throw cashError('Sessão CashBarber expirada. Peça ao administrador para conectar novamente.',409);
  }
  async login(tenant,page,{email,password}){
    await this.goto(page,'/auth/login',false);
    if(!page.url().includes('/auth'))return {connected:true};
    await page.getByPlaceholder('Informe o seu e-mail').fill(email);
    await page.getByPlaceholder('Informe sua senha').fill(password);
    await page.getByRole('button',{name:'Acessar',exact:true}).click();
    try{await page.getByRole('button',{name:'Menu do usuário',exact:true}).waitFor({timeout:25000});}catch{throw cashError('Não foi possível entrar. Confira as credenciais ou conclua eventuais verificações no CashBarber.',422);}
    await this.vault.write('session_'+tenant,await page.context().storageState());return {connected:true,status:'connected'};
  }
}
