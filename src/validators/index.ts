import loginValidate from './z-login';
import registerValidate, { validatePostRegistration as postRegisterValidate, validateUpdateUser as userUpdateValidate } from './z-register';
import validatePostCreate from './z-post-create';
import validateTagCreate from './z-tag-create';
import validateExchangeRateCreate, {validateUpdate as validateExchangeRateUpdate} from './z-exchange-rate'

export {
    loginValidate,
    registerValidate,
    postRegisterValidate,
    validatePostCreate,
    validateTagCreate,
    validateExchangeRateCreate,
    validateExchangeRateUpdate,
    userUpdateValidate,
}