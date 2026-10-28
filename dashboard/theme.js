// Palette and font choice for 设置 → 外观. State {palette, font} lives in localStorage (key office-theme).
// A palette is a CSS block in theme.css keyed by <html data-palette="id">; add it here and in theme.css (see THEME.md).
(()=>{
  const root=document.documentElement,KEY='office-theme';
  const options={
    // [id, label, swatch colours]. The picker hides the palette row while there is only one.
    palettes:[['default','原皮',['#117866','#f3f5f1','#172a22']]],
    fonts:[['default','默认'],['consolas','Consolas'],['cascadia','Cascadia Mono'],['courier','Courier New'],['simsun','宋体混排'],['lucida','Lucida Console']]
  };
  const has=(k,id)=>options[k].some(o=>o[0]===id);
  localStorage.removeItem('office-skin'); // earlier TUI skin, removed
  const get=()=>{
    let v={};try{v=JSON.parse(localStorage.getItem(KEY))||{}}catch{}
    return {palette:has('palettes',v.palette) ? v.palette : 'default',font:has('fonts',v.font) ? v.font : 'default'};
  };
  const apply=s=>{
    for(const k of ['palette','font']){if(s[k]==='default')delete root.dataset[k];else root.dataset[k]=s[k]}
  };
  window.officeTheme={options,get,set(patch){const s={...get(),...patch};localStorage.setItem(KEY,JSON.stringify(s));apply(get());return get()}};
  apply(get());
})();
