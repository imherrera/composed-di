import { ServiceContainer } from './services/serviceContainer.ts';
import { smsServiceFactory, SMS_SERVICE_KEY } from './sms/di/smsModule.ts';

(async function () {
  const services = new ServiceContainer();
  services.register(smsServiceFactory());
  await deeplyNestedFunction({ services });
})();

interface Context {
  services: ServiceContainer;
}

async function deeplyNestedFunction(context: Context) {
  await login({}, context);
}

async function login(request: any, context: Context) {
  const state = authorize(request);
  if (state === 'DEVICE_CHANGED') {
    const sms = await context.services.retrieve(SMS_SERVICE_KEY);
    sms.send(971233149, 'Hola Juan, tu pin es 22222');
  }

  return;
}

function authorize(_request: any): 'OK' | 'DEVICE_CHANGED' {
  return 'DEVICE_CHANGED';
}
