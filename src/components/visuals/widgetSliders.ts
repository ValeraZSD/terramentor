/**
 * Sliders in a widget — one look, and tracks that line up.
 *
 * A build drew each slider however it liked: one in the browser's own blue,
 * the next restyled into a grey bar of another height, and in a column of
 * `label slider value` rows every track started where its label happened to
 * end, so "Mass" and "Spring constant" put two tracks at two different x.
 * The compiler's prompt now asks for one slider style in one aligned grid, but
 * a prompt reaches only new builds; this goes into the head `buildWidgetDoc`
 * writes, so every cached build gets it too. Unlike the touch half it runs
 * with a mouse as well: alignment is not a question of the pointer.
 */

/**
 * The browser's own controls take the app's accent instead of its blue. In
 * `:where()` it has no specificity, so any colour the build chose still wins,
 * and a restyled slider (`appearance: none`) ignores `accent-color` anyway.
 */
export const WIDGET_SLIDER_CSS =
    ':where(input[type=range],input[type=checkbox],input[type=radio],progress){accent-color:var(--w-accent);}'
    // A drawn slider the script below turns native: its thumb and track rules
    // are pseudo-elements, which no inline style reaches.
    + 'input[data-w-native]::-webkit-slider-thumb,input[data-w-native]::-webkit-slider-runnable-track{-webkit-appearance:auto!important;appearance:auto!important;width:auto!important;height:auto!important;background:none!important;border:0!important;box-shadow:none!important;}'
    + 'input[data-w-native]::-moz-range-thumb,input[data-w-native]::-moz-range-track{appearance:auto!important;width:auto!important;height:auto!important;background:none!important;border:0!important;box-shadow:none!important;}';

/**
 * Lines up a column of slider rows: two or more rows under one parent, each
 * `label, slider[, value]` and nothing else, laid out as a flex row or as plain
 * inline content. Every label gets the widest label's width, every value the
 * widest value's (right-aligned, tabular figures), and in a flex row the slider takes the rest (up to 20rem, so
 * a wide desktop frame does not get a 700px track): each track starts and ends
 * at the same x. A `min-width` only raises a box to what its neighbour already
 * is, so a build that sized its own columns keeps them. Skipped: a grid (it
 * aligns already), a column flex (label above its slider, tracks share both
 * edges already), and labels wider than 45% of the row, which on a narrow
 * frame are better on their own line than squeezing every track.
 *
 * A widget that MIXES the two kinds of slider (the browser's own and one the
 * build drew with `appearance: none`) has its drawn ones turned back into the
 * browser's, in the accent: two sliders setting two numbers of one model
 * should not look like two different controls. That runs at
 * DOMContentLoaded, before the touch half decides how to grow each slider at
 * `load`. A widget whose sliders are ALL drawn is consistent and kept.
 *
 * Nothing is cleared before it is measured, so a column only grows: a value
 * that grows as its slider moves ("9 kg" to "10 kg") widens the column once
 * instead of nudging the track on every step. Passes run at `load`, when the
 * frame changes size (Edge gives the frame no width yet at `load`, so the first
 * pass finds nothing), when an element is added or a class/hidden/open changes
 * (a row shown later), and on a slider's `input`. Text written into a readout
 * runs none, or a readout updated every frame would measure every frame.
 */
export const WIDGET_SLIDER_JS = `(()=>{
var queued=0;
function rows(){
  var groups=new Map();
  document.querySelectorAll('input[type=range]').forEach(function(r){
    var row=r.parentElement;if(!row||row===document.body||row.querySelectorAll('input[type=range]').length!==1)return;
    var kids=row.children,i=Array.prototype.indexOf.call(kids,r);
    if(i!==1||kids.length>3)return;
    var shape=getComputedStyle(row).display;
    if(/grid/.test(shape))return;
    var flex=/flex/.test(shape);
    if(flex&&/column/.test(getComputedStyle(row).flexDirection))return;
    if(!flex&&getComputedStyle(kids[0]).display!=='inline'&&getComputedStyle(kids[0]).display!=='inline-block')return;
    var g=groups.get(row.parentElement);if(!g)groups.set(row.parentElement,g=[]);
    g.push({row:row,flex:flex,label:kids[0],input:r,value:kids[2]||null});
  });
  return groups;
}
function widest(els){var w=0;els.forEach(function(e){if(e){var b=e.getBoundingClientRect().width;if(b>w)w=b;}});return w;}
function own(r){var cs=getComputedStyle(r);return (cs.getPropertyValue('appearance')||cs.getPropertyValue('-webkit-appearance'))==='none';}
function unify(){
  var all=Array.prototype.slice.call(document.querySelectorAll('input[type=range]')),drawn=all.filter(own);
  if(!drawn.length||drawn.length===all.length)return;
  drawn.forEach(function(r){r.setAttribute('data-w-native','');var s=r.style;s.setProperty('-webkit-appearance','auto');s.setProperty('appearance','auto');s.background='transparent';s.border='0';s.height='auto';});
}
function align(){
  queued=0;
  try{unify();}catch(e){}
  rows().forEach(function(g){
    g=g.filter(function(x){return x.row.getBoundingClientRect().width>0;});
    if(g.length<2||g.some(function(x){return x.flex!==g[0].flex;}))return;
    var lw=widest(g.map(function(x){return x.label;}));
    if(lw>0.45*g[0].row.getBoundingClientRect().width)return;
    var vw=widest(g.map(function(x){return x.value;}));
    g.forEach(function(x){
      x.label.style.minWidth=lw+'px';
      if(!x.flex)x.label.style.display='inline-block';
      if(x.value){x.value.style.minWidth=vw+'px';x.value.style.fontVariantNumeric='tabular-nums';x.value.style.textAlign='right';if(!x.flex)x.value.style.display='inline-block';}
      if(x.flex){x.label.style.flexShrink='0';if(x.value)x.value.style.flexShrink='0';x.input.style.flexGrow='1';x.input.style.minWidth='0';if(getComputedStyle(x.input).maxWidth==='none')x.input.style.maxWidth='20rem';}
    });
  });
}
function el(n){return n.nodeType===1;}
function news(m){return m.type==='attributes'||Array.prototype.some.call(m.addedNodes,el)||Array.prototype.some.call(m.removedNodes,el);}
function later(){if(!queued)queued=setTimeout(align,50);}
function start(){
  try{align();}catch(e){}
  setTimeout(function(){try{align();}catch(e){}},0);
  document.addEventListener('input',function(e){if(e.target&&e.target.type==='range')later();},true);
  try{new ResizeObserver(later).observe(document.documentElement);}catch(e){}
  try{new MutationObserver(function(ms){if(ms.some(news))later();}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open']});}catch(e){}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){try{unify();}catch(e){}});
if(document.readyState==='complete')start();else window.addEventListener('load',start);
})();`;
