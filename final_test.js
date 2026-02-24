const axios = require('axios');

async function test() {
    try {
        const response = await axios.post('http://localhost:3000/stock', {
            userRequest: { utterance: '005930' }
        });
        console.log('Result for 005930:', JSON.stringify(response.data, null, 2));

        const response2 = await axios.post('http://localhost:3000/stock', {
            userRequest: { utterance: '삼성전자' }
        });
        console.log('Result for 삼성전자:', JSON.stringify(response2.data, null, 2));
    } catch (error) {
        console.error('Test error:', error.message);
    }
}

test();
