import UserModel from "../models/user.model";
import DatabaseService from "../config/db.config";

const backFillWhatsappNumber = async () => {
    try {
        const dbService = DatabaseService.getInstance();
        await dbService.connect();
        const result = await UserModel.updateMany(
           { whatsappNumber: { $exists: false } },
           { $set: { whatsappNumber: '$phoneNumber' } },
       )
        console.log(`Migrated ${result.modifiedCount} users`)
        process.exit(0)
    } catch (error) {
        console.error(error, "Back-filling of WhatsApp Number Failed")
        process.exit(1)
    }
}

backFillWhatsappNumber().then(() => console.log('Back-filling done...'));