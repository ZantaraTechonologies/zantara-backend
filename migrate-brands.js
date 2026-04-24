const mongoose = require('mongoose');
require('dotenv').config();

const migrateBrands = async () => {
    try {
        console.log('--- Phase B: Corrected Brand Migration ---');
        await mongoose.connect(process.env.MONGO_URI);
        
        const db = mongoose.connection.db;
        const brandsCollection = db.collection('brands');
        const identitiesCollection = db.collection('serviceidentities');
        const servicesCollection = db.collection('services');

        const allBrands = await brandsCollection.find({}).toArray();
        console.log(`Found ${allBrands.length} raw brand records.`);

        const groups = {};
        allBrands.forEach(b => {
            const name = (b.name || '').trim();
            if (!name) return;
            if (!groups[name]) groups[name] = [];
            groups[name].push(b);
        });

        for (const name in groups) {
            const group = groups[name];
            const master = group[0];
            
            // Extract typeId and current typeIds (if any)
            const typeIds = new Set();
            group.forEach(b => {
                if (b.typeId) typeIds.add(b.typeId.toString());
                if (b.typeIds && Array.isArray(b.typeIds)) {
                    b.typeIds.forEach(id => typeIds.add(id.toString()));
                }
            });

            const finalTypeIds = Array.from(typeIds).map(id => new mongoose.Types.ObjectId(id));
            const allMemberIds = group.map(b => b._id);
            const redundantIds = group.slice(1).map(b => b._id);

            console.log(`Processing "${name}": Merging ${group.length} records. Final Types: ${finalTypeIds.length}`);

            // 1. Update master
            await brandsCollection.updateOne(
                { _id: master._id },
                { 
                    $set: { typeIds: finalTypeIds },
                    $unset: { typeId: "" }
                }
            );

            // 2. Update Identity references
            await identitiesCollection.updateMany(
                { brandId: { $in: allMemberIds } },
                { $set: { brandId: master._id } }
            );

            // 3. Update Service references
            await servicesCollection.updateMany(
                { brandId: { $in: allMemberIds } },
                { $set: { brandId: master._id } }
            );

            // 4. Cleanup redundant
            if (redundantIds.length > 0) {
                await brandsCollection.deleteMany({ _id: { $in: redundantIds } });
            }
        }

        console.log('--- Migration Complete ---');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
};

migrateBrands();
