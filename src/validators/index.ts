import loginValidate from './z-login';
import registerValidate, { validatePostRegistration as postRegisterValidate, validateUpdateUser as userUpdateValidate } from './z-register';
import validatePostCreate from './z-post-create';
import validateTagCreate from './z-tag-create';
import validateExchangeRateCreate, {validateUpdate as validateExchangeRateUpdate} from './z-exchange-rate'
import {
    validateSetTransactionPin,
    validateChangeTransactionPin,
    validateForgotTransactionPin,
    validateResetTransactionPin,
} from './z-pin';

export {
    loginValidate,
    registerValidate,
    postRegisterValidate,
    validatePostCreate,
    validateTagCreate,
    validateExchangeRateCreate,
    validateExchangeRateUpdate,
    userUpdateValidate,
    validateSetTransactionPin,
    validateChangeTransactionPin,
    validateForgotTransactionPin,
    validateResetTransactionPin,
}