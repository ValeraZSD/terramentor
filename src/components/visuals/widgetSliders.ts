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
    // A drawn slider the script below turns native. In the stylesheet with
    // !important, so a build that paints its track from script on every
    // `input` (a gradient fill in `style.background`) cannot undo it, and so
    // the thumb and track, pseudo-elements no inline style reaches, are reset
    // too.
    + 'input[data-w-native]{-webkit-appearance:auto!important;appearance:auto!important;background:transparent!important;border:0!important;height:auto!important;}'
    + 'input[data-w-native]::-webkit-slider-thumb,input[data-w-native]::-webkit-slider-runnable-track{-webkit-appearance:auto!important;appearance:auto!important;width:auto!important;height:auto!important;background:none!important;border:0!important;box-shadow:none!important;}'
    + 'input[data-w-native]::-moz-range-thumb,input[data-w-native]::-moz-range-track{appearance:auto!important;width:auto!important;height:auto!important;background:none!important;border:0!important;box-shadow:none!important;}';

/**
 * Lines up a column of slider rows: two or more rows under one parent, each
 * `label, slider[, value]` and nothing else, laid out as a flex row or as plain
 * inline content. Every label gets the widest label's width, every value the
 * widest value's (aligned to the end, tabular figures), and in a flex row the
 * slider takes the rest, up to 20rem so a wide desktop frame does not get a
 * 700px track: each track starts and ends at the same x. A `min-width` only
 * raises a box to what its neighbour already is, and it is border-box, so a
 * padded label measured at its full width is not grown by its padding again on
 * the next pass. Skipped: a grid (it aligns already), a column flex (label
 * above its slider), a "label" or "value" that is a control (a − slider +
 * stepper), and a column that would leave a track under 120px or labels wider
 * than 45% of the row. When a column stops fitting (a narrower frame), what
 * this set on it is taken back.
 *
 * A widget that MIXES the two kinds of slider (the browser's own and one the
 * build drew with `appearance: none`) has its drawn ones turned back into the
 * browser's, in the accent: two sliders setting two numbers of one model
 * should not look like two different controls. That runs at
 * DOMContentLoaded, before the touch half decides how to grow each slider at
 * `load`. A widget whose sliders are ALL drawn is consistent and kept, and an
 * invisible slider (opacity 0, laid over a track the build drew) counts as
 * neither.
 *
 * Nothing is cleared before it is measured, so a column only grows: a value
 * that grows as its slider moves ("9 kg" to "10 kg") widens the column once
 * instead of nudging the track on every step. Passes run at `load`, when the
 * frame changes size (Edge gives the frame no width yet at `load`, so the first
 * pass finds nothing), on a slider's `input`, and when an element holding a
 * slider is added, removed or has its class/hidden/open changed (a row shown
 * later). Any other mutation runs none, so a build that rewrites a readout or
 * toggles classes elsewhere on every frame costs nothing here.
 */
export const WIDGET_SLIDER_JS = `(()=>{
var queued=0,ours=[],MIN_TRACK=120,KEYS=['minWidth','boxSizing','display','flexShrink','flexGrow','maxWidth','fontVariantNumeric','textAlign'];
function control(e){return !!e&&/^(BUTTON|SELECT|TEXTAREA|INPUT)$/.test(e.tagName);}
function rows(){
  var groups=new Map();
  document.querySelectorAll('input[type=range]').forEach(function(r){
    var row=r.parentElement;if(!row||row===document.body||row.querySelectorAll('input[type=range]').length!==1)return;
    var kids=row.children,i=Array.prototype.indexOf.call(kids,r);
    if(i!==1||kids.length>3||control(kids[0])||control(kids[2]))return;
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
function set(e,k,v){if(ours.indexOf(e)<0)ours.push(e);e.style[k]=v;}
function undo(g){g.forEach(function(x){[x.label,x.value,x.input].forEach(function(e){var at=e?ours.indexOf(e):-1;if(at<0)return;ours.splice(at,1);KEYS.forEach(function(k){e.style[k]='';});});});}
function seen(r){return getComputedStyle(r).opacity!=='0';}
function own(r){var cs=getComputedStyle(r);return (cs.getPropertyValue('appearance')||cs.getPropertyValue('-webkit-appearance'))==='none';}
function unify(){
  var all=Array.prototype.filter.call(document.querySelectorAll('input[type=range]'),seen),drawn=all.filter(own);
  if(!drawn.length||drawn.length===all.length)return;
  drawn.forEach(function(r){r.setAttribute('data-w-native','');});
}
function align(){
  queued=0;
  ours=ours.filter(function(e){return e.isConnected;});
  try{unify();}catch(e){}
  rows().forEach(function(g){
    g=g.filter(function(x){return x.row.getBoundingClientRect().width>0;});
    if(g.length<2||g.some(function(x){return x.flex!==g[0].flex;}))return;
    var rw=g[0].row.getBoundingClientRect().width,lw=widest(g.map(function(x){return x.label;})),vw=widest(g.map(function(x){return x.value;}));
    if(lw>0.45*rw||lw+vw+MIN_TRACK>rw){undo(g);return;}
    g.forEach(function(x){
      set(x.label,'boxSizing','border-box');set(x.label,'minWidth',lw+'px');
      if(!x.flex)set(x.label,'display','inline-block');
      if(x.value){set(x.value,'boxSizing','border-box');set(x.value,'minWidth',vw+'px');set(x.value,'fontVariantNumeric','tabular-nums');set(x.value,'textAlign','end');if(!x.flex)set(x.value,'display','inline-block');}
      if(x.flex){set(x.label,'flexShrink','0');if(x.value)set(x.value,'flexShrink','0');set(x.input,'flexGrow','1');set(x.input,'minWidth','0');if(getComputedStyle(x.input).maxWidth==='none')set(x.input,'maxWidth','20rem');}
    });
  });
}
function holds(n){return !!n&&n.nodeType===1&&(n.matches('input[type=range]')||!!n.querySelector('input[type=range]'));}
function news(m){return m.type==='attributes'?holds(m.target):Array.prototype.some.call(m.addedNodes,holds)||Array.prototype.some.call(m.removedNodes,holds);}
function later(){if(!queued)queued=setTimeout(function(){try{align();}catch(e){queued=0;}},50);}
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
