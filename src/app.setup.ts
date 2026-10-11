import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/** HTTP-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.enableShutdownHooks();
}

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Merchant Onboarding API')
    .setDescription(
      'Merchant application lifecycle with asynchronous risk review. ' +
        'Authenticate via POST /auth/login and use the token with "Authorize".',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: false },
  });
}
