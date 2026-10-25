/* ui_patch.js v4 — 标准阅读器点击UI逻辑补丁
 * 用法：在 reader.html 的 init(); 后面加 <script src="ui_patch.js"></script>
 * 效果：点击中间→弹出/收起顶栏+底栏；左30%翻上页；右30%翻下页
 */
(function(){
var C='';
C+='.rd-foot{transform:translateY(100%)!important;-webkit-transform:translateY(100%)!important}';
C+='.rd-foot.show{transform:translateY(0)!important;-webkit-transform:translateY(0)!important}';
C+='.rd-menu,.rd-rail,.rd-hint,.rd-slide{display:none!important}';
C+='.rd-rangep{padding:0 10px 8px;display:block}';
C+='.rd-rangep input[type=range]{display:block;width:100%;margin:0;padding:0}';
var st=document.createElement('style');st.id='uiPatch';
if(st.styleSheet)st.styleSheet.cssText=C;else st.innerHTML=C;
document.getElementsByTagName('head')[0].appendChild(st);

RD_UI_ON=0;RD_UI_TIMER=0;

function rdToggleUI(){RD_UI_ON=!RD_UI_ON;rdChrome();rdScheduleAutoHide();}
function rdScheduleAutoHide(){
 if(!RD_UI_ON||!(RD_CFG.imm*1))return;
 if(RD_UI_TIMER){try{clearTimeout(RD_UI_TIMER);}catch(e){}}
 RD_UI_TIMER=setTimeout(function(){RD_UI_TIMER=0;RD_UI_ON=0;rdChrome();},3500);
}

rdChrome=function(){
 var u=RD_UI_ON,t=$('rdTop'),f=$('rdFoot'),p=$('srcTop'),q=$('srcFoot');
 if(t)t.className=u?'rd-top show':'rd-top';
 if(f)f.className=u?'rd-foot show':'rd-foot';
 if(p)p.className=u?'rd-top show':'rd-top';
 if(q)q.className=u?'rd-foot show':'rd-foot';
};

rdCloseDrawers=function(){
 RD_DRAW='';RD_UI_ON=0;
 if(RD_UI_TIMER){try{clearTimeout(RD_UI_TIMER);}catch(e){}RD_UI_TIMER=0;}
 rdChrome();
 var m=$('rdMask');if(m)m.className='rd-mask';
 var t=$('rdToc');if(t)t.className='rd-toc';
 var s=$('rdSet');if(s)s.className='rd-set';
};

rdTap=function(v,e){
 e=e||window.event;
 if(RD_DRAW||v.busy)return;
 var now=new Date().getTime();
 if(v.swT&&now-v.swT<700)return;
 try{if(window.getSelection){var s=window.getSelection();if(s&&String(s).length>0)return;}}catch(x){}
 var t=RD_CFG.tap;
 if(t==='off')return;
 if(t==='all'){v.next();return;}
 var st=v.stage;if(!st)return;
 var r=st.getBoundingClientRect();
 var x=((e.clientX||0)-(r.left||0))/(r.width||1);
 if(x<0.3)v.prev();else if(x>0.7)v.next();else rdToggleUI();
};

rdKeys=function(e){
 e=e||window.event;
 if(!RD_READING)return;
 var k=e.keyCode||e.which;
 if(k===27){if(RD_DRAW)rdCloseDrawers();return;}
 if(RD_DRAW)return;
 var v=rdActive();if(!v)return;
 if(k===84){rdToggleUI();if(e.preventDefault)e.preventDefault();return;}
 if(k===37||k===33){v.prev();}
 else if(k===39||k===34||k===32){v.next();}
 else return;
 if(e.preventDefault)e.preventDefault();
};

function rm(id){var e=$(id);if(e&&e.parentNode)e.parentNode.removeChild(e);}
rm('rdRail');rm('hintL');rm('hintR');rm('rdMenu');

var sl=document.querySelector('.rd-slide');
if(sl)sl.className='rd-rangep';

var srcTop=$('srcTop');if(srcTop)srcTop.className='rd-top';

var sf=$('srcFoot');
if(sf&&!sf.querySelector('.rd-rangep')){
 var rp=document.createElement('div');
 rp.className='rd-rangep';
 rp.innerHTML='<input type="range" id="srcRange" min="1" max="1" value="1">';
 sf.appendChild(rp);
 if(VIEW.src)VIEW.src.range=$('srcRange');
 on($('srcRange'),'change',function(){
  var n=parseInt(this.value,10);
  if(!n||!VIEW.src)return;
  VIEW.src.gotoLocal(VIEW.src.pageOff[n]||0,true);
 });
}

function rebind(id,fn,vr,prop){
 var e=$(id);if(!e)return;
 var c=e.cloneNode(true);
 e.parentNode.replaceChild(c,e);
 on(c,'click',fn);
 if(vr&&prop)vr[prop]=c;
}
rebind('btnPrev',function(){VIEW.doc.prev();rdScheduleAutoHide();},VIEW.doc,'navPrev');
rebind('btnNext',function(){VIEW.doc.next();rdScheduleAutoHide();},VIEW.doc,'navNext');
rebind('btnRdPrev2',function(){VIEW.src.prev();rdScheduleAutoHide();},VIEW.src,'navPrev');
rebind('btnRdNext2',function(){VIEW.src.next();rdScheduleAutoHide();},VIEW.src,'navNext');
rebind('btnRdPrev',function(){prevChapter();rdScheduleAutoHide();});
rebind('btnRdNext',function(){nextChapter();rdScheduleAutoHide();});

var rr=$('rdRange');
if(rr){
 var rrc=rr.cloneNode(true);
 rr.parentNode.replaceChild(rrc,rr);
 if(VIEW.doc)VIEW.doc.range=rrc;
 on(rrc,'change',function(){
  var n=parseInt(this.value,10);
  if(!n||!VIEW.doc)return;
  VIEW.doc.gotoLocal(VIEW.doc.pageOff[n]||0,true);
  if(VIEW.doc.onMove)VIEW.doc.onMove();
 });
 on(rrc,'input',function(){rdScheduleAutoHide();});
}

rdOpenContent=function(d){
 CUR=d;CONTENT=String(d.content);
 msg('正在排版《'+(CUR.title||'')+'》…',true);
 show('read');
 setTimeout(function(){
  var v=VIEW.doc;
  v.defTitle=(CUR.title||'');
  v.onMove=function(){rdSaveProg(0);};
  rdSetTitle();
  v.setDoc(CONTENT,d.progress||0,true);
  RD_UI_ON=1;rdChrome();rdScheduleAutoHide();
  var n=(v.segs?v.segs.length:1);
  msg('已打开《'+(CUR.title||'')+'》· 共 '+CONTENT.length+' 字 · '+n+' 段 · 当前 '+(Math.round((d.progress||0)*1000)/10)+'%');
 },30);
};

openChapter=function(i){
 if(SR_BUSY)return;
 if(i<0||i>=SR_CHS.length)return;
 SR_BUSY=true;
 var ch=SR_CHS[i];
 var s=SR_SEL?SR_SEL.bs:null;
 if(!s){SR_BUSY=false;return;}
 var t0=new Date().getTime();
 msg('加载第 '+(i+1)+'/'+SR_CHS.length+' 章（'+calcPct(i+1,SR_CHS.length)+'）：'+ch.name+' ...',true);
 proxyFetch(ch.url,function(err,text,finalUrl){
  SR_BUSY=false;
  if(err){msg('章节加载失败：'+err.message);return;}
  var doc=htmlDoc(text);
  if(!doc){msg('页面解析失败');return;}
  var rule=s.ruleContent||{};
  var body=pickText(rule.content||'',doc,finalUrl||ch.url,'\n');
  if(!body){msg('正文提取为空（该规则可能不支持）');return;}
  body=body.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n');
  SR_CHIDX=i;
  var t=$('srcChapTitle');
  if(t){t.textContent='第 '+(i+1)+'/'+SR_CHS.length+' 章（'+calcPct(i+1,SR_CHS.length)+'）· '+ch.name+' · 本章 '+body.length+' 字 · 加载 '+elapsed(t0);}
  showSrcRead();
  VIEW.src.defTitle=ch.name;
  VIEW.src.setDoc(body,0,true);
  RD_UI_ON=1;rdChrome();rdScheduleAutoHide();
  msg('已加载：'+ch.name+'（本章 '+body.length+' 字，用时 '+elapsed(t0)+'）');
 });
};

rdChrome();
console.log('[UI Patch v4] loaded');
})();
