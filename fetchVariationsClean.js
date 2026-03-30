const axios = require('axios');
const fs = require('fs');

async function getVariations() {
    const services = ['waec', 'jamb', 'neco', 'nabteb', 'waec-registration'];
    let output = '';
    
    for (const s of services) {
        try {
            const url = `https://sandbox.vtpass.com/api/service-variations?serviceID=${s}`;
            const res = await axios.get(url, { timeout: 10000 });
            if (res.data.content && res.data.content.variations) {
                const vars = res.data.content.variations.map(v => v.variation_code).join(', ');
                output += `${s} --> ${vars}\n`;
            } else {
                output += `${s} --> NO VARIATIONS (code: ${res.data.code})\n`;
            }
        } catch(e) {
            output += `${s} --> ERROR: ${e.message}\n`;
        }
    }
    fs.writeFileSync('exam_vars.txt', output);
}
getVariations();
