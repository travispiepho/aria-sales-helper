package expo.modules.ariafloorscan

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * ARCore floor perimeter capture for Freedom Flooring's one-stop proposal.
 *
 * The rep/homeowner walks the room and taps each floor corner. Every tap uses
 * ARCore's hit test and prefers a DepthPoint when AUTOMATIC depth is available,
 * then falls back to a detected plane/feature point. Closing the polygon
 * returns true metric perimeter and area to React Native; product and proposal
 * workflows can consume square footage without any paid scanning SDK.
 */
class FloorScanActivity : Activity(), GLSurfaceView.Renderer {
  companion object {
    const val EXTRA_RESULT = "aria_floor_scan_result"
    const val EXTRA_ERROR = "aria_floor_scan_error"
    private const val CAMERA_PERMISSION_REQUEST = 9021
    private const val METERS_TO_FEET = 3.280839895013123
  }

  private lateinit var surface: GLSurfaceView
  private lateinit var instructions: TextView
  private lateinit var measurement: TextView
  private lateinit var undoButton: Button
  private lateinit var finishButton: Button
  private val cameraBackground = CameraBackgroundRenderer()

  @Volatile private var latestFrame: Frame? = null
  private var session: Session? = null
  private var installRequested = false
  private var depthEnabled = false
  private val points = mutableListOf<FloatArray>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUi()
  }

  private fun buildUi() {
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    surface = GLSurfaceView(this).apply {
      preserveEGLContextOnPause = true
      setEGLContextClientVersion(2)
      setRenderer(this@FloorScanActivity)
      renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
      setOnTouchListener { _, event ->
        if (event.action == MotionEvent.ACTION_UP) addCorner(event.x, event.y)
        true
      }
    }
    root.addView(surface, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    val topPanel = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(18), dp(18), dp(14))
      setBackgroundColor(0xCC0B3D62.toInt())
    }
    val title = TextView(this).apply {
      text = "Floor Scan"
      textSize = 23f
      setTextColor(Color.WHITE)
      setTypeface(typeface, android.graphics.Typeface.BOLD)
    }
    instructions = TextView(this).apply {
      text = "Move slowly until the floor is tracked, then tap each corner in order."
      textSize = 14f
      setTextColor(0xFFD9EAF6.toInt())
      setPadding(0, dp(5), 0, 0)
    }
    topPanel.addView(title)
    topPanel.addView(instructions)
    root.addView(topPanel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

    val reticle = TextView(this).apply {
      text = "+"
      textSize = 38f
      gravity = Gravity.CENTER
      setTextColor(0xFFFFFFFF.toInt())
    }
    root.addView(reticle, FrameLayout.LayoutParams(dp(64), dp(64), Gravity.CENTER))

    val bottomPanel = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(14), dp(16), dp(20))
      setBackgroundColor(0xDD111827.toInt())
    }
    measurement = TextView(this).apply {
      text = "0 corners · move around the room"
      textSize = 16f
      setTextColor(Color.WHITE)
      gravity = Gravity.CENTER
      setPadding(0, 0, 0, dp(12))
    }
    val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    val cancel = button("Cancel", 0xFF374151.toInt()) { setResult(Activity.RESULT_CANCELED); finish() }
    undoButton = button("Undo", 0xFF475569.toInt()) { undoCorner() }.apply { isEnabled = false }
    finishButton = button("Finish Room", 0xFF16A34A.toInt()) { finishScan() }.apply { isEnabled = false }
    buttons.addView(cancel, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(6) })
    buttons.addView(undoButton, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(6); marginEnd = dp(6) })
    buttons.addView(finishButton, LinearLayout.LayoutParams(0, dp(50), 1.35f).apply { marginStart = dp(6) })
    bottomPanel.addView(measurement)
    bottomPanel.addView(buttons)
    root.addView(bottomPanel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    setContentView(root)
  }

  override fun onResume() {
    super.onResume()
    if (!hasCameraPermission()) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
      return
    }
    ensureSessionAndResume()
  }

  private fun ensureSessionAndResume() {
    try {
      if (session == null) {
        when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
          ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
            installRequested = true
            return
          }
          ArCoreApk.InstallStatus.INSTALLED -> Unit
        }
        val arSession = Session(this)
        val config = arSession.config
        depthEnabled = arSession.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
        if (depthEnabled) config.depthMode = Config.DepthMode.AUTOMATIC
        config.planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
        arSession.configure(config)
        session = arSession
        instructions.text = if (depthEnabled) {
          "Depth is active. Move slowly, then tap each floor corner in order."
        } else {
          "Depth is unavailable on this device. Using ARCore plane tracking; move slowly and tap each corner."
        }
      }
      session?.resume()
      surface.onResume()
    } catch (error: UnavailableException) {
      fail("ARCore is unavailable: ${error.message ?: error.javaClass.simpleName}")
    } catch (error: CameraNotAvailableException) {
      fail("The camera is unavailable. Close other camera apps and retry.")
    } catch (error: Throwable) {
      fail(error.message ?: "Unable to start floor scan")
    }
  }

  override fun onPause() {
    surface.onPause()
    session?.pause()
    super.onPause()
  }

  override fun onDestroy() {
    session?.close()
    session = null
    super.onDestroy()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == CAMERA_PERMISSION_REQUEST) {
      if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) ensureSessionAndResume()
      else fail("Camera permission is required to measure a room.")
    }
  }

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0.03f, 0.07f, 0.11f, 1f)
    cameraBackground.createOnGlThread()
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    session?.setDisplayGeometry(windowManager.defaultDisplay.rotation, width, height)
  }

  override fun onDrawFrame(gl: GL10?) {
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    try {
      val arSession = session ?: return
      if (cameraBackground.textureId > 0) arSession.setCameraTextureNames(intArrayOf(cameraBackground.textureId))
      val frame = arSession.update()
      latestFrame = frame
      cameraBackground.draw(frame)
    } catch (_: CameraNotAvailableException) {
      runOnUiThread { fail("The camera became unavailable during scanning.") }
    } catch (_: Throwable) {
      // A transient tracking frame should not abort the scan.
    }
  }

  private fun addCorner(x: Float, y: Float) {
    val frame = latestFrame ?: return showHint("Move the phone until AR tracking starts.")
    if (frame.camera.trackingState != TrackingState.TRACKING) return showHint("Keep moving slowly so ARIA can map the floor.")
    val hit = frame.hitTest(x, y).firstOrNull { result ->
      val trackable = result.trackable
      trackable is DepthPoint ||
        (trackable is Plane && trackable.isPoseInPolygon(result.hitPose)) ||
        (trackable is Point && trackable.orientationMode == Point.OrientationMode.ESTIMATED_SURFACE_NORMAL)
    } ?: return showHint("No floor surface at that point yet. Move closer and try again.")

    val t = hit.hitPose.translation
    points.add(floatArrayOf(t[0], t[1], t[2]))
    updateMeasurementUi()
    showHint(if (points.size < 3) "Corner ${points.size} added. Continue around the room." else "Corner ${points.size} added. Tap Finish Room when the perimeter is complete.")
  }

  private fun undoCorner() {
    if (points.isNotEmpty()) points.removeAt(points.lastIndex)
    updateMeasurementUi()
  }

  private fun updateMeasurementUi() {
    val perimeter = openPathLength(points)
    val area = if (points.size >= 3) polygonAreaOnFloor(points) else 0.0
    val feet = perimeter * METERS_TO_FEET
    val sqft = area * METERS_TO_FEET * METERS_TO_FEET
    measurement.text = buildString {
      append("${points.size} corner${if (points.size == 1) "" else "s"}")
      if (points.size >= 2) append(" · ${"%.1f".format(feet)} ft traced")
      if (points.size >= 3) append(" · ${"%.1f".format(sqft)} sq ft")
    }
    undoButton.isEnabled = points.isNotEmpty()
    finishButton.isEnabled = points.size >= 3 && area > 0.01
  }

  private fun finishScan() {
    if (points.size < 3) return
    val areaM2 = polygonAreaOnFloor(points)
    val perimeterM = closedPerimeter(points)
    val pointBundles = ArrayList<Bundle>(points.size)
    points.forEach { p -> pointBundles.add(Bundle().apply { putDouble("x", p[0].toDouble()); putDouble("y", p[1].toDouble()); putDouble("z", p[2].toDouble()) }) }
    val capturedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    val result = Bundle().apply {
      putString("unit", "metric")
      putDouble("areaSquareMeters", areaM2)
      putDouble("areaSquareFeet", areaM2 * METERS_TO_FEET * METERS_TO_FEET)
      putDouble("perimeterMeters", perimeterM)
      putInt("pointCount", points.size)
      putParcelableArrayList("points", pointBundles)
      putString("depthMode", if (depthEnabled) "automatic" else "plane-fallback")
      putString("capturedAt", capturedAt)
    }
    setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_RESULT, result))
    finish()
  }

  private fun polygonAreaOnFloor(vertices: List<FloatArray>): Double {
    if (vertices.size < 3) return 0.0
    var sum = 0.0
    vertices.indices.forEach { i ->
      val a = vertices[i]
      val b = vertices[(i + 1) % vertices.size]
      sum += a[0].toDouble() * b[2].toDouble() - b[0].toDouble() * a[2].toDouble()
    }
    return abs(sum) / 2.0
  }

  private fun openPathLength(vertices: List<FloatArray>): Double = vertices.zipWithNext().sumOf { (a, b) -> distanceOnFloor(a, b) }
  private fun closedPerimeter(vertices: List<FloatArray>): Double = if (vertices.size < 2) 0.0 else openPathLength(vertices) + distanceOnFloor(vertices.last(), vertices.first())
  private fun distanceOnFloor(a: FloatArray, b: FloatArray): Double {
    val dx = (a[0] - b[0]).toDouble()
    val dz = (a[2] - b[2]).toDouble()
    return sqrt(dx * dx + dz * dz)
  }

  private fun showHint(text: String) { instructions.text = text }
  private fun hasCameraPermission() = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
  private fun fail(message: String) {
    setResult(Activity.RESULT_FIRST_USER, Intent().putExtra(EXTRA_ERROR, message))
    finish()
  }
  private fun button(text: String, color: Int, onClick: () -> Unit) = Button(this).apply {
    this.text = text
    setTextColor(Color.WHITE)
    setBackgroundColor(color)
    isAllCaps = false
    textSize = 14f
    setOnClickListener { onClick() }
  }
  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
