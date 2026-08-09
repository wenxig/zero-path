package com.zeropath.phonesimulator.security

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

data class ShellSession(val token: String, val expiresAt: Instant)

class PinManager(context: Context) {
  private val preferences = context.getSharedPreferences("zero_path_shell_pin", Context.MODE_PRIVATE)
  private val random = SecureRandom()
  @Volatile private var activeSession: ShellSession? = null

  val configured: Boolean
    get() = preferences.contains(KEY_HASH) && preferences.contains(KEY_SALT)

  @Synchronized
  fun setPin(pin: String) {
    require(pin.length in 8..64) { "PIN must contain 8 to 64 characters" }
    val salt = ByteArray(32).also(random::nextBytes)
    val hash = hash(pin, salt)
    preferences.edit()
      .putString(KEY_SALT, Base64.getEncoder().encodeToString(salt))
      .putString(KEY_HASH, Base64.getEncoder().encodeToString(hash))
      .remove(KEY_FAILED_ATTEMPTS)
      .remove(KEY_LOCKED_UNTIL_MS)
      .apply()
    activeSession = null
  }

  @Synchronized
  fun arm(pin: String): ShellSession {
    require(pin.length in 8..64) { "PIN must contain 8 to 64 characters" }
    val now = System.currentTimeMillis()
    val lockedUntil = preferences.getLong(KEY_LOCKED_UNTIL_MS, 0)
    require(now >= lockedUntil) {
      "PIN verification is locked for ${(lockedUntil - now + 999) / 1_000} seconds"
    }
    val salt = preferences.getString(KEY_SALT, null)?.let { Base64.getDecoder().decode(it) }
      ?: throw IllegalStateException("Set a local shell PIN first")
    val expected = preferences.getString(KEY_HASH, null)?.let { Base64.getDecoder().decode(it) }
      ?: throw IllegalStateException("Set a local shell PIN first")
    if (!MessageDigest.isEqual(hash(pin, salt), expected)) {
      recordFailure(now)
      throw IllegalArgumentException("Invalid PIN")
    }
    preferences.edit().remove(KEY_FAILED_ATTEMPTS).remove(KEY_LOCKED_UNTIL_MS).apply()
    val sessionToken = ByteArray(32).also(random::nextBytes).let {
      Base64.getUrlEncoder().withoutPadding().encodeToString(it)
    }
    return ShellSession(sessionToken, Instant.now().plusSeconds(15 * 60L)).also {
      activeSession = it
    }
  }

  @Synchronized
  fun requireValidSession(token: String) {
    val session = activeSession
    val valid = session != null && session.expiresAt.isAfter(Instant.now()) && MessageDigest.isEqual(
      session.token.toByteArray(Charsets.UTF_8), token.toByteArray(Charsets.UTF_8),
    )
    if (!valid) {
      if (session != null && !session.expiresAt.isAfter(Instant.now())) activeSession = null
      throw IllegalArgumentException("Invalid or expired shell session")
    }
  }

  private fun hash(pin: String, salt: ByteArray): ByteArray {
    val spec = PBEKeySpec(pin.toCharArray(), salt, KDF_ITERATIONS, KDF_BITS)
    return try {
      SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    } finally {
      spec.clearPassword()
    }
  }

  private fun recordFailure(now: Long) {
    val attempts = (preferences.getInt(KEY_FAILED_ATTEMPTS, 0) + 1).coerceAtMost(31)
    val exponent = (attempts - 1).coerceAtMost(10)
    val delayMs = (1_000L shl exponent).coerceAtMost(MAX_LOCK_MS)
    preferences.edit()
      .putInt(KEY_FAILED_ATTEMPTS, attempts)
      .putLong(KEY_LOCKED_UNTIL_MS, now + delayMs)
      .apply()
  }

  companion object {
    private const val KDF_BITS = 256
    private const val KDF_ITERATIONS = 210_000
    private const val MAX_LOCK_MS = 15 * 60 * 1_000L
    private const val KEY_FAILED_ATTEMPTS = "failed_attempts"
    private const val KEY_HASH = "hash"
    private const val KEY_LOCKED_UNTIL_MS = "locked_until_ms"
    private const val KEY_SALT = "salt"
  }
}
