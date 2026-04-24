const mongoose = require('mongoose');
require('dotenv').config();

const ServiceCategory = require('../models/ServiceCategory');
const ServiceType = require('../models/ServiceType');
const Brand = require('../models/Brand');
const Service = require('../models/Service');
const Provider = require('../models/Provider');
const ProviderOffer = require('../models/ProviderOffer');

const slugify = (text) => text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-');

async function backfill() {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected.');

        // 1. Initial Categories
        const categories = [
            { name: 'VTU Services', slug: 'vtu', desc: 'Airtime, Data, and Cable TV' },
            { name: 'Utility Bills', slug: 'utility', desc: 'Electricity and Water' },
            { name: 'Education', slug: 'education', desc: 'Exam PINS and Result Checkers' },
            { name: 'Verification', slug: 'verification', desc: 'KYC and identity verification' }
        ];

        const categoryMap = {};
        for (const cat of categories) {
            let record = await ServiceCategory.findOne({ slug: cat.slug });
            if (!record) {
                record = await ServiceCategory.create({
                    name: cat.name,
                    slug: cat.slug,
                    description: cat.desc
                });
                console.log(`Created Category: ${cat.name}`);
            }
            categoryMap[cat.slug] = record._id;
        }

        // 2. Initial Types
        const types = [
            { name: 'Airtime', slug: 'airtime', categorySlug: 'vtu', workflow: 'topup' },
            { name: 'Data Bundle', slug: 'data', categorySlug: 'vtu', workflow: 'topup' },
            { name: 'Cable TV', slug: 'tv', categorySlug: 'vtu', workflow: 'choice_selection' },
            { name: 'Electricity', slug: 'electricity', categorySlug: 'utility', workflow: 'validation' },
            { name: 'Exam PIN', slug: 'pin', categorySlug: 'education', workflow: 'topup' }
        ];

        const typeMap = {};
        for (const type of types) {
            let record = await ServiceType.findOne({ slug: type.slug, categoryId: categoryMap[type.categorySlug] });
            if (!record) {
                record = await ServiceType.create({
                    name: type.name,
                    slug: type.slug,
                    categoryId: categoryMap[type.categorySlug],
                    workflowType: type.workflow
                });
                console.log(`Created Type: ${type.name}`);
            }
            typeMap[type.slug] = record._id;
        }

        // 3. Brands (Identify Brands from Services)
        const services = await Service.find({});
        console.log(`Processing ${services.length} services...`);

        const brandMap = {};
        for (const service of services) {
            // Rough brand detection logic
            let brandName = 'Other';
            const name = service.name.toUpperCase();
            
            // Fix data anomaly: If name contains "AIRTIME" but category is "tv", force it to "airtime"
            if (service.category === 'tv' && name.includes('AIRTIME')) {
                service.category = 'airtime';
            }

            if (name.includes('MTN')) brandName = 'MTN';
            else if (name.includes('AIRTEL')) brandName = 'Airtel';
            else if (name.includes('GLO')) brandName = 'Glo';
            else if (name.includes('9MOBILE') || name.includes('ETISALAT')) brandName = '9mobile';
            else if (name.includes('DSTV')) brandName = 'DSTV';
            else if (name.includes('GOTV')) brandName = 'GOTV';
            else if (name.includes('STARTIMES')) brandName = 'Startimes';
            else if (name.includes('SHOWMAX')) brandName = 'Showmax';
            else if (name.includes('SMILE')) brandName = 'Smile';
            else if (name.includes('WAEC')) brandName = 'WAEC';
            else if (name.includes('JAMB')) brandName = 'JAMB';
            else if (name.includes('NECO')) brandName = 'NECO';
            else if (name.includes('NABTEB')) brandName = 'NABTEB';
            else if (name.includes('IKEJA')) brandName = 'Ikeja Electric';
            else if (name.includes('EKO')) brandName = 'Eko Electric';
            else if (name.includes('ABUJA')) brandName = 'Abuja Electric';
            else if (name.includes('KANO')) brandName = 'Kano Electric';
            else if (name.includes('ENUGU')) brandName = 'Enugu Electric';
            else if (name.includes('JOS')) brandName = 'Jos Electric';
            else if (name.includes('KADUNA')) brandName = 'Kaduna Electric';
            else if (name.includes('BENIN')) brandName = 'Benin Electric';
            else if (name.includes('PORT HARCOURT') || name.includes('PHED')) brandName = 'PH Electric';
            else if (name.includes('IBADAN')) brandName = 'Ibadan Electric';
            else if (name.includes('YOLA')) brandName = 'Yola Electric';
            else if (name.includes('ABA')) brandName = 'Aba Electric';

            const brandSlug = slugify(brandName);
            const typeId = typeMap[service.category]; // Use existing category as fallback type detection

            if (typeId) {
                let brandRecord = await Brand.findOne({ slug: brandSlug, typeId });
                if (!brandRecord) {
                    brandRecord = await Brand.create({
                        name: brandName,
                        slug: brandSlug,
                        typeId
                    });
                    console.log(`Created Brand: ${brandName} for Type: ${service.category}`);
                }
                brandMap[`${brandSlug}_${service.category}`] = brandRecord._id;

                // 4. Update Service & Create ProviderOffer
                service.categoryId = categoryMap[types.find(t => t.slug === service.category)?.categorySlug] || null;
                service.typeId = typeId;
                service.brandId = brandRecord._id;
                
                // Set fulfillment mode based on type
                if (service.category === 'electricity') service.fulfillmentMode = 'sync'; // but requires validation flow
                
                await service.save();

                // Create ProviderOffer
                const provider = await Provider.findOne({ name: { $regex: new RegExp(`^${service.provider}$`, 'i') } });
                if (provider) {
                    await ProviderOffer.findOneAndUpdate(
                        { serviceId: service._id, providerId: provider._id },
                        {
                            providerCode: service.providerCode,
                            costPrice: service.costPrice || 0,
                            priority: 1,
                            status: service.status
                        },
                        { upsert: true }
                    );
                }
            }
        }

        console.log('Backfill complete.');
        process.exit(0);
    } catch (err) {
        console.error('Backfill failed:', err);
        process.exit(1);
    }
}

backfill();
