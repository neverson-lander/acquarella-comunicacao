export async function readApiResponse(response){
  try{
    const data=await response.json();
    if(data===null||typeof data!=='object')throw Error('Invalid response');
    return data;
  }catch{
    const status=response.ok?502:response.status;
    const message=[502,503,504].includes(status)
      ?'A central está temporariamente indisponível. Aguarde alguns instantes e retome a consulta.'
      :'Não foi possível ler a resposta da central. Tente novamente.';
    throw Object.assign(Error(message),{status});
  }
}
