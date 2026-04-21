const Provider = require('../models/Provider');
const providerService = require('../services/provider.service');

const getAllProviders = async (req, res) => {
    try {
        const providers = await Provider.find().sort({ name: 1 });
        res.json({ success: true, data: providers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const createProvider = async (req, res) => {
    try {
        const provider = await Provider.create(req.body);
        res.status(201).json({ success: true, data: provider });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const updateProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findByIdAndUpdate(id, req.body, { new: true });
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });
        res.json({ success: true, data: provider });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const deleteProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findByIdAndDelete(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });
        res.json({ success: true, message: 'Provider deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getProviderBalance = async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findById(id);
        if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

        // Logic to fetch balance from external API via adapter
        const adapter = await providerService.getAdapterInstance(provider.name);
        const result = await adapter.checkBalance();
        
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message || 'Balance check failed' });
        }

        provider.balance = result.balance;
        provider.lastBalanceCheck = new Date();
        await provider.save();

        res.json({ success: true, balance: result.balance });
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getAllProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    getProviderBalance
};
