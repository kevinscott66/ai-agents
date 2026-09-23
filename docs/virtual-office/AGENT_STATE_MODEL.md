# AgentState и визуальное поведение

Статус: проектируемый engine-independent контракт.

## Авторитетное состояние

AgentState = `{agentId, role, availability, lifecycle, activity, activeRuns, primaryRunId, taskId, projectId, progress, currentFile, repository, branch, tests, blockers, recentActionIds, updatedAt, evidence, freshness, capabilities}`.

availability = online/offline/unknown; lifecycle = enabled/paused/disabled; freshness = fresh/stale/unknown. activity nullable: отсутствие наблюдения не равно IDLE. У каждого activeRun собственные state/task/updatedAt, чтобы concurrent jobs одной роли не затирали друг друга. UI показывает количество работ и выбирает primaryRun детерминированно (user-selected, иначе последний подтверждённый активный); не смешивает task одного run и tool другого.

| activity | Требуемое подтверждение |
|---|---|
| OFFLINE | подтверждённая недоступность execution runtime; потеря socket даёт stale, не OFFLINE |
| IDLE | backend подтвердил отсутствие активных runs при доступном исполнителе |
| THINKING | generation started без активного tool; только lifecycle, без hidden reasoning |
| READING | инструмент чтения действительно started |
| RESEARCHING | search/research tool started |
| CODING | наблюдаемая операция редактирования started |
| TERMINAL | разрешённый shell process started |
| TESTING | явно классифицированный test run started |
| REVIEWING | backend review job started |
| WAITING | queue, approval или явный blocker; reason обязателен |
| WAITING_TOOL | ожидание tool result при отсутствии более точного activity |
| COMMUNICATING | реальная отправка/handoff с correlation |
| MEETING | backend meeting intent active; не обычное NPC сближение |
| ERROR | подтверждённый run failure с безопасной причиной |
| DONE | подтверждённое завершение конкретного run |

Эти значения поддерживаются протоколом, но **не все доступны из текущей телеметрии**. Existing task running → active run, activity=null; action.executed → recent action, не длительное CODING. Telegram bot health → channel health, не гарантия idle/runtime ready. paused/disabled хранятся отдельно. Процент null до надёжного producer.

## Переходы

Общий путь run: queued/WAITING → generation/THINKING → tool activity → generation → DONE/ERROR. Из любого active состояния возможен WAITING/WAITING_TOOL при явном сигнале. Tool finish восстанавливает актуальную родительскую фазу, не безусловный IDLE. DONE/ERROR терминальны для run, новый run имеет новый ID. Новая authoritative snapshot может корректно перескочить через пропущенные фазы.

Reducer проверяет schema, identity, revision и run correlation. Запоздалое событие завершённого run не меняет новый. Unknown activity расширения отображается нейтрально. Stale timeout не завершает задачу: сохраняет последнее наблюдение с возрастом и отключает claim «сейчас работает».

## PresentationState (только клиент)

`{location, locomotion, posture, interaction, visualActivity, gazeTarget, seatReservation, ambientSeed, nextAmbientAt}`. Не отправляется как AgentState.

Locomotion: idle → start → walk → decelerate → stop → turn-in-place → idle. Kinematic controller задаёт acceleration/deceleration, animation mixer смешивает скорость/поворот; navigation управляет путём, не teleport. Seat FSM: reserve → approach → align → sit → seated → stand → release. Ошибка пути/занятое кресло → безопасный standing idle и повтор с backoff; backend task не затрагивается.

CODING допускает typing/read-monitor/mouse/pause. IDLE допускает stretch/coffee/phone/window/kitchen. WAITING — спокойное ожидание с честным статусом. Разные seeded delays и клипы исключают синхронные idle loops. Не отвлекать активно работающего персонажа длинным ambient маршрутом.

MVP: ходьба, сидение, вставание, working/idle/waiting blend. Phase 2: foot IK, hand anchors, head/eye tracking, turn-in-place refinement, grasp/release object attachment, chair/body turn, mocap variation. IK компенсирует контакт, не заменяет отсутствующий sit/stand clip. Для каждого ассета нужны compatible skeleton/retarget profile и лицензия.

## Awareness, talk, meetings

Близость игрока запускает ограниченный gaze с плавным весом. E/Talk прерывает interruptible visual animation: typing stop → hands off keyboard → body/head turn → conversation pose. Input в UI не вызывает повторную отправку. После закрытия инспектора controller выбирает поведение из **текущего**, а не сохранённого до разговора AgentState.

Communication отображается сразу как уведомление, независимо от скорости NPC. Walk-to-colleague — необязательная визуализация. Meeting intent: завершить interruptible ambient → stand → reserve meeting seat → navigate → sit. Неуспевший NPC не блокирует реальный meeting. После завершения возвращается к своему месту. Ambient разговор обязательно помечен визуальным; он не создаёт communication event backend.

## Инварианты и acceptance

Ни movement, ни кофе, ни gaze не вызывают LLM или меняют task status. Нет роста progress от animation time. Stale feed виден пользователю. Chat по конкретной роли не заменяется ответом Lead без явного объяснения. 13 мест не порождают 13 identities. Проверки reducer используют fake clock и concurrent run fixtures; motion acceptance — наблюдаемый playtest с препятствиями, повторным E, занятым seat и потерей соединения.
