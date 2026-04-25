const VTPassAdapter = require('../adapters/vtpass.adapter');

const adapter = new VTPassAdapter({ baseUrl: 'http://localhost', apiKey: 'test' });

const mockResponse = {
    code: "000",
    response_description: "TRANSACTION SUCCESSFUL",
    content: {
        transactions: {
            transactionId: "VTP-123",
            unit_price: "499.00",
            commission: "14.97",
            total_amount: "484.03",
            convinience_fee: "0.00"
        }
    }
};

const result = adapter.mapResponse(mockResponse);

console.log('--- TEST RESULTS ---');
console.log('Success:', result.success);
console.log('Financials:', JSON.stringify(result.financials, null, 2));

if (result.financials) {
    console.log('ASSERTIONS:');
    console.log('vendorCost is 484.03:', result.financials.vendorCost === 484.03);
    console.log('vendorCommission is 14.97:', result.financials.vendorCommission === 14.97);
    console.log('source is actual:', result.financials.source === 'actual');
} else {
    console.error('FAILED: No financials extracted');
}
