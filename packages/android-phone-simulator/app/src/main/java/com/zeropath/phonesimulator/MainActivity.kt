package com.zeropath.phonesimulator

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.zeropath.phonesimulator.audio.AudioTestSnapshot
import com.zeropath.phonesimulator.remote.GatewayService

class MainActivity : Activity() {
  private val container
    get() = (application as ZeroPathApplication).container
  private lateinit var statusView: TextView
  private lateinit var gatewayStatusView: TextView
  private var listener: AutoCloseable? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestRuntimePermissions()
    setContentView(buildContent())
    listener = container.audioController.addListener { runOnUiThread { render(it) } }
    container.gatewayClient.onStatus = { runOnUiThread { gatewayStatusView.text = it } }
  }

  override fun onDestroy() {
    listener?.close()
    super.onDestroy()
  }

  private fun buildContent(): ScrollView {
    val density = resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(20), dp(20), dp(32))
      setBackgroundColor(Color.rgb(244, 246, 244))
    }
    content.addView(TextView(this).apply {
      text = "Zero Path Audio Test"
      textSize = 25f
      setTextColor(Color.rgb(25, 34, 29))
      setPadding(0, 0, 0, dp(16))
    })
    content.addView(status("Device ID: ${container.gatewayClient.deviceId}"))

    val gatewayUrl = field("Gateway WebSocket", container.config.gatewayUrl)
    val gatewayToken = field("Gateway token", container.config.gatewayToken, true)
    val allowInsecureGateway = CheckBox(this).apply {
      text = "Allow insecure ws:// for LAN development"
      isChecked = container.config.allowInsecureGateway
    }
    val esp32Address = field("ESP32 Bluetooth address", container.config.esp32Address)
    val pin = field("Local shell PIN", "", true)
    content.addView(gatewayUrl)
    content.addView(gatewayToken)
    content.addView(allowInsecureGateway)
    content.addView(esp32Address)
    content.addView(pin)

    content.addView(row(
      button("Start gateway") {
        container.config.gatewayUrl = gatewayUrl.text.toString()
        container.config.gatewayToken = gatewayToken.text.toString()
        container.config.allowInsecureGateway = allowInsecureGateway.isChecked
        startForegroundService(Intent(this, GatewayService::class.java))
      },
      button("Set PIN") {
        val value = pin.text.toString()
        container.commandExecutor.execute {
          runCatching { container.pinManager.setPin(value) }
            .onSuccess { runOnUiThread { Toast.makeText(this, "PIN updated", Toast.LENGTH_SHORT).show() } }
            .onFailure { error ->
              runOnUiThread {
                Toast.makeText(this, error.message ?: "Operation failed", Toast.LENGTH_LONG).show()
              }
            }
        }
      },
    ))
    gatewayStatusView = status("gateway stopped")
    content.addView(gatewayStatusView)

    content.addView(row(
      button("Connect ESP32") {
        runAction {
          container.config.esp32Address = esp32Address.text.toString()
          container.audioController.connect(container.config.esp32Address.ifBlank { null })
        }
      },
      button("Disconnect") { container.audioController.transport.disconnect() },
    ))
    content.addView(row(
      button("Upload tone") { runAction { container.audioController.startUpload("tone-440", 10_000) } },
      button("Upload silence") { runAction { container.audioController.startUpload("silence", 10_000) } },
    ))
    content.addView(row(
      button("Download tone") { runAction { container.audioController.startDownload(10_000) } },
      button("Stop all") {
        container.audioController.stopUpload()
        container.audioController.stopDownload()
      },
    ))
    statusView = status("idle")
    content.addView(statusView)
    return ScrollView(this).apply { addView(content) }
  }

  private fun field(label: String, initial: String, password: Boolean = false) = EditText(this).apply {
    hint = label
    setText(initial)
    setSingleLine(true)
    if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
  }

  private fun button(label: String, action: () -> Unit) = Button(this).apply {
    text = label
    setOnClickListener { action() }
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
      marginEnd = 8
    }
  }

  private fun row(vararg views: Button) = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    views.forEach(::addView)
  }

  private fun status(initial: String) = TextView(this).apply {
    text = initial
    textSize = 15f
    setTextColor(Color.rgb(45, 57, 50))
    setPadding(8, 16, 8, 16)
  }

  private fun render(snapshot: AudioTestSnapshot) {
    statusView.text = listOf(
      "ESP32: ${if (snapshot.connected) "connected" else "disconnected"}",
      "State: ${snapshot.state}",
      "Uploaded: ${snapshot.sentFrames} frames",
      "Downloaded: ${snapshot.receivedFrames} frames",
      "Dropped: ${snapshot.droppedFrames} frames",
      "WAV: ${snapshot.lastDownloadPath ?: "none"}",
      "Status: ${snapshot.status}",
    ).joinToString("\n")
  }

  private fun runAction(action: () -> Unit) {
    runCatching(action).onFailure {
      Toast.makeText(this, it.message ?: "Operation failed", Toast.LENGTH_LONG).show()
    }
  }

  private fun requestRuntimePermissions() {
    if (Build.VERSION.SDK_INT < 31) return
    val permissions = mutableListOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
    if (Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.POST_NOTIFICATIONS
    val missing = permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 100)
  }
}
