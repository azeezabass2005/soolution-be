export class UserService {
private profileUploadService = FileUploadFactory.getProfileUploadService();

/**
* Create user with profile picture in a service method
  */
  public async createUserWithAvatar(
  userData: any,
  profilePictureFile?: Express.Multer.File
  ): Promise<any> {
  let profilePictureUrl: string | null = null;

    if (profilePictureFile) {
      const uploadResult = await this.profileUploadService.uploadFile(profilePictureFile, {
        folder: 'profiles/avatars/',
        customFilename: `user_${userData.email}`,
        makePublic: true
      });

      if (uploadResult.success) {
        profilePictureUrl = uploadResult.file!.url;
      } else {
        throw new Error(`Failed to upload profile picture: ${uploadResult.error}`);
      }
    }

    const user = {
      ...userData,
      profilePictureUrl,
      createdAt: new Date()
    };

    // Save to database
    // return await this.userRepository.create(user);
    return user;
}

/**
* Update user avatar
  */
  public async updateUserAvatar(
  userId: string,
  profilePictureFile: Express.Multer.File,
  oldProfilePictureKey?: string
  ): Promise<string> {
  // Delete old profile picture if exists
  if (oldProfilePictureKey) {
  await this.profileUploadService.deleteFile(oldProfilePictureKey);
  }

    const uploadResult = await this.profileUploadService.uploadFile(profilePictureFile, {
      folder: 'profiles/avatars/',
      customFilename: `user_${userId}`,
      makePublic: true
    });

    if (!uploadResult.success) {
      throw new Error(`Failed to upload profile picture: ${uploadResult.error}`);
    }

    return uploadResult.file!.url;
}
}
