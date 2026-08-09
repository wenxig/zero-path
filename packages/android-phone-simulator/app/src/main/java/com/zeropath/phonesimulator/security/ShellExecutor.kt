package com.zeropath.phonesimulator.security

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

data class ShellResult(
  val exitCode: Int,
  val output: String,
  val truncated: Boolean,
  val durationMs: Long,
)

class ShellExecutor(private val pinManager: PinManager) {
  private val outputExecutor = Executors.newSingleThreadExecutor()
  private val executionSlot = Semaphore(1)

  fun execute(command: String, sessionToken: String, timeoutMs: Long): ShellResult {
    require(command.isNotBlank()) { "Command is empty" }
    require(timeoutMs in 100..120_000) { "Invalid shell timeout" }
    pinManager.requireValidSession(sessionToken)
    require(executionSlot.tryAcquire()) { "Another shell command is already running" }
    val startedAt = System.nanoTime()
    var process: Process? = null
    var processPid: Int? = null
    var outputFuture: Future<Pair<ByteArray, Boolean>>? = null
    try {
      val wrappedCommand = "printf '__ZERO_PATH_PID__%s\\n' \"\$\$\"; $command"
      val activeProcess = ProcessBuilder(SETSID_PATH, SHELL_PATH, "-c", wrappedCommand)
        .redirectErrorStream(true)
        .start()
      process = activeProcess
      processPid = readProcessPid(activeProcess.inputStream)
      outputFuture = outputExecutor.submit<Pair<ByteArray, Boolean>> {
        val output = ByteArrayOutputStream()
        var truncated = false
        val chunk = ByteArray(4_096)
        activeProcess.inputStream.use { input ->
          while (true) {
            val count = input.read(chunk)
            if (count < 0) break
            val remaining = MAX_OUTPUT_BYTES - output.size()
            if (remaining > 0) output.write(chunk, 0, minOf(count, remaining))
            if (count > remaining) truncated = true
          }
        }
        output.toByteArray() to truncated
      }
      val completed = activeProcess.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
      if (!completed) {
        terminateProcessTree(activeProcess, processPid)
        throw IllegalStateException("Shell command timed out after $timeoutMs ms")
      }
      terminateProcessTree(activeProcess, processPid)
      val (output, truncated) = outputFuture.get(2, TimeUnit.SECONDS)
      val durationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
      return ShellResult(activeProcess.exitValue(), output.toString(Charsets.UTF_8), truncated, durationMs)
    } finally {
      if (process?.isAlive == true) terminateProcessTree(process, processPid)
      runCatching { process?.outputStream?.close() }
      runCatching { process?.inputStream?.close() }
      runCatching { process?.errorStream?.close() }
      outputFuture?.cancel(true)
      executionSlot.release()
    }
  }

  private fun terminateProcessTree(process: Process, pid: Int?) {
    pid?.let(::descendantsOf)?.asReversed()?.forEach { childPid ->
      runCatching { android.os.Process.killProcess(childPid) }
    }
    pid?.let { runCatching { android.system.Os.kill(-it, android.system.OsConstants.SIGKILL) } }
    runCatching { process.destroyForcibly() }
    runCatching { process.waitFor(2, TimeUnit.SECONDS) }
  }

  private fun readProcessPid(input: InputStream): Int {
    val prefix = "__ZERO_PATH_PID__"
    val line = ByteArrayOutputStream()
    while (line.size() <= 64) {
      val byte = input.read()
      require(byte >= 0) { "Shell process exited before reporting its PID" }
      if (byte == '\n'.code) break
      line.write(byte)
    }
    val value = String(line.toByteArray(), Charsets.US_ASCII)
    require(value.startsWith(prefix)) { "Shell process returned an invalid PID marker" }
    return value.removePrefix(prefix).toInt()
  }

  private fun descendantsOf(rootPid: Int): List<Int> {
    val childrenByParent = File("/proc").listFiles()
      ?.mapNotNull { directory ->
        val pid = directory.name.toIntOrNull() ?: return@mapNotNull null
        readParentPid(File(directory, "stat"))?.let { parentPid -> parentPid to pid }
      }
      ?.groupBy({ it.first }, { it.second })
      .orEmpty()
    val descendants = mutableListOf<Int>()
    val pending = ArrayDeque(childrenByParent[rootPid].orEmpty())
    while (pending.isNotEmpty()) {
      val pid = pending.removeFirst()
      descendants += pid
      pending.addAll(childrenByParent[pid].orEmpty())
    }
    return descendants
  }

  private fun readParentPid(statFile: File): Int? = runCatching {
    val stat = statFile.readText()
    val fields = stat.substring(stat.lastIndexOf(')') + 2).split(' ', limit = 3)
    fields[1].toInt()
  }.getOrNull()

  companion object {
    private const val MAX_OUTPUT_BYTES = 64 * 1024
    private const val SETSID_PATH = "/system/bin/setsid"
    private const val SHELL_PATH = "/system/bin/sh"
  }
}
