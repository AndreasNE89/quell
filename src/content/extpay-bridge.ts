// ExtPay content-script bridge for https://extensionpay.com/* (onPaid / login callbacks).
// Must call ExtPay(id) so the library can talk to the service worker.

import ExtPay from 'extpay';
import { EXTPAY_EXTENSION_ID, isExtPayConfigured } from '../shared/extpay-config.js';

if (isExtPayConfigured()) {
  ExtPay(EXTPAY_EXTENSION_ID);
}
