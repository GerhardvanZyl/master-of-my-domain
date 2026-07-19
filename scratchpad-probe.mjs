import Database from 'better-sqlite3';
const db = new Database('data/app.db');
const rows = db.prepare(`
  SELECT id, address, latitude, longitude, price_numeric, beds, listing_url
  FROM properties
  WHERE pt_minutes_to_flinders IS NULL AND latitude IS NOT NULL
`).all();
function score(beds, price){ if(price==null) return -Infinity; return (beds??0) - Math.abs(price-850000)/25000; }
rows.sort((a,b)=>score(b.beds,b.price_numeric)-score(a.beds,a.price_numeric));
const done = db.prepare(`SELECT COUNT(*) c FROM properties WHERE pt_minutes_to_flinders IS NOT NULL`).get().c;
console.log('DONE:', done, 'REMAINING:', rows.length);
console.log(JSON.stringify(rows.slice(0,16).map(r=>({id:r.id,a:r.address,lat:r.latitude,lng:r.longitude,url:r.listing_url})),null,1));
