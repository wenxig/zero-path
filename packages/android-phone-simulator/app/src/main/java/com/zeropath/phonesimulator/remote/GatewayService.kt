package com.zeropath.phonesimulator.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.zeropath.phonesimulator.ZeroPathApplication

class GatewayService : Service() {
  private val container
    get() = (application as ZeroPathApplication).container

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Audio test gateway", NotificationManager.IMPORTANCE_LOW),
    )
    val notification = android.app.Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Zero Path audio test")
      .setContentText("LAN MCP device connection is active")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .build()
    startForeground(NOTIFICATION_ID, notification)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val config = container.config
    return runCatching {
      container.gatewayClient.start(
        config.gatewayUrl,
        config.gatewayToken,
        config.allowInsecureGateway,
      )
    }
      .fold(
        onSuccess = { START_STICKY },
        onFailure = {
          container.gatewayClient.onStatus("gateway start failed: ${it.message}")
          stopSelf()
          START_NOT_STICKY
        },
      )
  }

  override fun onDestroy() {
    container.gatewayClient.stop()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private const val CHANNEL_ID = "zero_path_gateway"
    private const val NOTIFICATION_ID = 41
  }
}
