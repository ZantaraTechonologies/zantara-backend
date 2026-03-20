const bcrypt = require('bcryptjs');

async function testPin() {
    const pin = '1234';
    const wrongPin = '5678';
    
    console.log('Testing PIN hashing and verification...');
    
    const hashed = await bcrypt.hash(pin, 10);
    console.log('Hashed PIN:', hashed);
    
    const isMatch1 = await bcrypt.compare(pin, hashed);
    console.log('Match 1234 (Correct):', isMatch1);
    
    const isMatch2 = await bcrypt.compare(wrongPin, hashed);
    console.log('Match 5678 (Wrong):', isMatch2);
    
    if (isMatch1 === true && isMatch2 === false) {
        console.log('PIN logic is correct.');
    } else {
        console.error('PIN logic is BROKEN!');
    }
}

testPin();
