/**
 * Error thrown when there is an issue during the initialization or configuration of a ServiceModule.
 * This can include circular dependencies or missing dependencies that are detected during module creation.
 */
export class ServiceModuleInitError extends Error {
  name = 'ServiceModuleInitError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Error thrown when a requested service cannot be found within the ServiceModule.
 * This typically occurs when no factory has been registered for the given ServiceKey.
 */
export class ServiceFactoryNotFoundError extends Error {
  name = 'ServiceFactoryNotFoundError';

  constructor(message: string) {
    super(message);
  }
}
