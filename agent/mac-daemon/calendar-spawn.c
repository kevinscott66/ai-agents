/*
 * agent-calendar-run — прокладка, которая запускает помощника EventKit «сам за себя».
 *
 * Разрешение на Календарь TCC спрашивает не у того, кто обращается к EventKit, а у
 * «ответственного» процесса. В демоне им на всё поддерево становится bun: у обычного
 * бинаря нет строки о том, зачем ему календарь, поэтому диалог не показывается вовсе,
 * а доступ отказывается молча — сколько ни выдавай права самому помощнику.
 *
 * responsibility_spawnattrs_setdisclaim снимает это наследование: запущенный помощник
 * отвечает за себя, и решает уже его собственная запись TCC. Символ приватный, поэтому
 * берём его через dlsym — если его не окажется, помощник всё равно запустится, просто
 * упрётся в прежний отказ.
 *
 * Помощника ищем соседним файлом рядом с собой, по разыменованному пути: в релизе
 * лежат ссылки на постоянную папку, а разрешение TCC привязано к настоящему пути.
 * Наружу прокладка не печатает ничего — stderr помощника разбирается построчно.
 */
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef int (*disclaim_fn)(posix_spawnattr_t *, int);

static const char HELPER[] = "agent-calendar";

int main(int argc, char **argv) {
  char self[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0) return 2;
  char resolved[PATH_MAX];
  if (realpath(self, resolved) == NULL) return 2;
  char *slash = strrchr(resolved, '/');
  if (slash == NULL) return 2;
  if ((size_t)(slash - resolved) + 1 + sizeof(HELPER) > sizeof(resolved)) return 2;
  strcpy(slash + 1, HELPER);

  char **args = calloc((size_t)argc + 1, sizeof(char *));
  if (args == NULL) return 2;
  args[0] = resolved;
  for (int i = 1; i < argc; i++) args[i] = argv[i];

  posix_spawnattr_t attr;
  if (posix_spawnattr_init(&attr) != 0) return 2;
  disclaim_fn disclaim = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (disclaim != NULL) disclaim(&attr, 1);
  pid_t pid = 0;
  int rc = posix_spawn(&pid, resolved, NULL, &attr, args, environ);
  posix_spawnattr_destroy(&attr);
  free(args);
  if (rc != 0) return 2;

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 2;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 2;
}
