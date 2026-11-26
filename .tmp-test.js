const https=require("https");
function q(url){return new Promise((res,rej)=>{https.get(url,{headers:{"User-Agent":"beijing-walk/1.0 (test)"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(d));}).on("error",rej);});}
const names=["盘山","天津古文化街","衡水湖","白石山","承德避暑山庄","山海关","平遥古城","五台山","长白山","镜泊湖"];
(async()=>{
for(const n of names){
  const u="https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch="+encodeURIComponent(n)+"&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url|mime|extmetadata";
  try{const t=await q(u);const j=JSON.parse(t);const pages=j.query&&j.query.pages?Object.values(j.query.pages):[];
    const list=pages.map(p=>({t:p.title,m:p.imageinfo&&p.imageinfo[0].mime}));
    console.log(n,"=>",JSON.stringify(list));
  }catch(e){console.log(n,"ERR",e.message);}
}
})();
