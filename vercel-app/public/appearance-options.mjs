export const appearanceOptions=[
  {id:'original',name:'Original',description:'O visual claro que você já conhece.'},
  {id:'petrol',name:'Azul-petróleo',description:'Mais contraste, com mensagens enviadas em azul.'},
  {id:'sage',name:'Verde-sálvia',description:'Tons suaves de verde e fundo menos luminoso.'},
  {id:'graphite',name:'Grafite',description:'Tons escuros no atendimento para reduzir a luminosidade.'}
];
export const validAppearance=value=>appearanceOptions.some(option=>option.id===value);
