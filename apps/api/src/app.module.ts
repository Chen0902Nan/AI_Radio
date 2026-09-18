// 应用装配：按层次组织模块；Controller → 业务模块 → 外部接入/存储 的依赖方向。
import { Module } from '@nestjs/common'
import { DbService } from './persistence/db.service'
import { NeteaseService } from './music/netease.service'
import { MusicController } from './music/music.controller'
import { CodexService } from './codex/codex.service'
import { OrchestratorService } from './preparation/orchestrator.service'
import { PreparationController } from './preparation/preparation.controller'
import { FishService } from './dj/fish.service'
import { DjScriptService } from './dj/dj-script.service'
import { DjPipelineService } from './dj/dj-pipeline.service'
import { DjController } from './dj/dj.controller'
import { ListeningService } from './listening/listening.service'
import { ListeningController } from './listening/listening.controller'
import { EventsService } from './events/events.service'
import { EventsController } from './events/events.controller'
import { StaticController } from './http/static.controller'
import { TestHooksController } from './test-support/test-hooks.controller'
import { TEST_HOOKS } from './config/app-config'

@Module({
  // 测试钩子只在显式 RADIO_TEST_HOOKS=1 时注册；正常启动没有可修改测试状态的路由
  controllers: TEST_HOOKS
    ? [MusicController, PreparationController, DjController, ListeningController, EventsController, TestHooksController, StaticController]
    : [MusicController, PreparationController, DjController, ListeningController, EventsController, StaticController],
  providers: [DbService, NeteaseService, CodexService, OrchestratorService, FishService, DjScriptService, DjPipelineService, ListeningService, EventsService],
})
export class AppModule {}
