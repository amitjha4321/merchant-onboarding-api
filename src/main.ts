import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  setupSwagger(app);

  const port = app.get(ConfigService).getOrThrow<number>('port');
  await app.listen(port);
  Logger.log(`API listening on :${port} — docs at /docs`, 'Bootstrap');
}

void bootstrap();
