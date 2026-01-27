// test-ghana-card-verification.ts

import { IUser } from "../models/interface";
import SmileId from "../services/smile-id.service";

async function testGhanaCardVerification() {
    const smileIdService = new SmileId();
    
    // Create a test user object
    const testUser: Partial<IUser> = {
        _id: 'test-user-id-123',
        firstName: 'John',
        lastName: 'Doe',
        email: 'test@example.com',
        countryOfOrigin: 'GH',
        countryOfResidence: 'GH'
    };

    // Create a simple test image (1x1 pixel PNG in base64)
    // In real testing, you'd use actual document and selfie images
    const testDocumentImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const testSelfieImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const images = [
        {
            image: testDocumentImage,
            image_type_id: 2 // Document image type
        },
        {
            image: testSelfieImage,
            image_type_id: 4 // Selfie image type
        }
    ];

    try {
        console.log('Starting Ghana Card verification test...');
        // Use a test Ghana Card number - in sandbox mode, Smile ID accepts test numbers
        const testGhanaCardNumber = 'GHA-123456789-0';
        console.log('Using test Ghana Card number:', testGhanaCardNumber);
        
        const result = await smileIdService.verifyGhanaCardWithSelfie(
            testUser as IUser,
            testGhanaCardNumber,
            images
        );
        
        console.log('\n✅ Test completed successfully!');
        console.log('Result:', result);
    } catch (error) {
        console.error('\n❌ Test failed:', error);
    }
}

testGhanaCardVerification();