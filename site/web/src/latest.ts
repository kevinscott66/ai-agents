/**
 * «Считается только последний запрос».
 *
 * `useAsync` решает это внутри эффекта: свой AbortController и флаг `active`,
 * cleanup отменяет предыдущий. Но там, где загрузку запускает не только
 * эффект, а ещё и кнопки («Показать ещё», «Повторить»), эффекту нечего
 * отменять — его контроллер к чужому запросу отношения не имеет.
 *
 * Аудит 2026-08-12: в DigestsSection на этом ловилась гонка. «Показать ещё»
 * уходило вообще без signal; пользователь тем временем набирал запрос, эффект
 * отменял СВОЙ контроллер и грузил выдачу поиска — а потом досыпался ответ
 * старого «Показать ещё» и через `[...prev, ...res.items]` дописывался прямо
 * в результаты поиска. Замер (копия старого load() поверх игрушечного
 * состояния):
 *
 *   после поиска: items=кит-0,кит-1 offset=2 total=2
 *   после хвоста: items=кит-0,кит-1,all-6,all-7,all-8,all-9,all-10,all-11
 *                 offset=12 total=100
 *   в выдаче поиска «кит» 8 карточек, из них чужих: 6
 *
 * offset и total при этом уезжают на значения прошлого запроса, то есть
 * следующее «Показать ещё» просит не ту страницу.
 *
 * Здесь — общий сторож: каждый `start()` отменяет предыдущий запрос и выдаёт
 * `isCurrent()`. Отмены мало (ответ мог уже прийти и разбираться), поэтому
 * проверка поколения обязательна — это тот же `active`, что в useAsync.
 */
export interface LatestRun {
  signal: AbortSignal;
  /** false, если после этого запуска был ещё один (или было `cancel`). */
  isCurrent(): boolean;
}

export interface Latest {
  start(): LatestRun;
  cancel(): void;
}

export function createLatest(): Latest {
  let ctrl: AbortController | null = null;
  let gen = 0;

  return {
    start(): LatestRun {
      ctrl?.abort();
      ctrl = new AbortController();
      const mine = ++gen;
      return { signal: ctrl.signal, isCurrent: () => mine === gen };
    },
    cancel(): void {
      ctrl?.abort();
      ctrl = null;
      gen++;
    },
  };
}
