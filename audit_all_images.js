const fs = require('fs');
const path = require('path');

const baseDir = 'c:\\Users\\USER\\Downloads\\ballondor-clone';
const htmlFiles = fs.readdirSync(baseDir).filter(f => f.endsWith('.html'));

console.log(`Auditing ${htmlFiles.length} HTML files...`);

let totalBroken = 0;

htmlFiles.forEach(file => {
  const filePath = path.join(baseDir, file);
  const content = fs.readFileSync(filePath, 'utf8');

  // Find all image references: in <img src="..."> and in JS strings ("assets/...")
  const regex = /(?:src=["']|["'])(assets\/[^"'\s>]+)["']/gi;
  let m;
  const missing = new Set();
  
  while ((m = regex.exec(content)) !== null) {
    let relPath = m[1];
    // Clean query params or hashes
    relPath = relPath.split('?')[0].split('#')[0];
    
    // Ignore template expressions like ${p1.img}
    if (relPath.includes('${')) continue;

    const fullPath = path.join(baseDir, relPath.replace(/\//g, '\\'));
    if (!fs.existsSync(fullPath)) {
      missing.add(relPath);
    }
  }

  if (missing.size > 0) {
    console.log(`\n❌ ${file} has ${missing.size} missing images:`);
    missing.forEach(img => console.log(`   - ${img}`));
    totalBroken += missing.size;
  } else {
    console.log(`✅ ${file}: All image paths exist!`);
  }
});

console.log(`\nTotal broken image references across site: ${totalBroken}`);
