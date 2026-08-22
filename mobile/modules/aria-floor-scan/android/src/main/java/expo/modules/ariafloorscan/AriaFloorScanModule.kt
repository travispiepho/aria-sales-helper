package expo.modules.ariafloorscan

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.google.ar.core.ArCoreApk
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST_FLOOR_SCAN = 7412

class AriaFloorScanModule : Module() {
  private var pendingScan: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("AriaFloorScan")

    AsyncFunction("getSupportAsync") {
      val context = requireNotNull(appContext.reactContext) { "React context is unavailable" }
      val availability = ArCoreApk.getInstance().checkAvailability(context)
      Bundle().apply {
        putString("platform", "android")
        putBoolean("arCoreSupported", availability.isSupported)
        putString("availability", availability.name)
      }
    }

    AsyncFunction("startScanAsync") { promise: Promise ->
      if (pendingScan != null) {
        promise.reject("ERR_SCAN_IN_PROGRESS", "A floor scan is already in progress", null)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_NO_ACTIVITY", "The current Android activity is unavailable", null)
        return@AsyncFunction
      }
      pendingScan = promise
      activity.startActivityForResult(Intent(activity, FloorScanActivity::class.java), REQUEST_FLOOR_SCAN)
    }

    OnActivityResult { _, (requestCode, resultCode, data) ->
      if (requestCode != REQUEST_FLOOR_SCAN) return@OnActivityResult
      val promise = pendingScan ?: return@OnActivityResult
      pendingScan = null
      when (resultCode) {
        Activity.RESULT_OK -> promise.resolve(data?.getBundleExtra(FloorScanActivity.EXTRA_RESULT))
        Activity.RESULT_CANCELED -> promise.resolve(null)
        else -> promise.reject(
          "ERR_FLOOR_SCAN",
          data?.getStringExtra(FloorScanActivity.EXTRA_ERROR) ?: "Floor scan failed",
          null,
        )
      }
    }

    OnDestroy {
      pendingScan?.reject("ERR_MODULE_DESTROYED", "Floor scan was interrupted", null)
      pendingScan = null
    }
  }
}
