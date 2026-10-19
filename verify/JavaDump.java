// Runs the ORIGINAL Java model classes from plate-tectonics_ja.jar headlessly and dumps
// model state as JSON so it can be diffed against the HTML5 port (see compare.js).
//
//   javac -cp ../plate-tectonics_ja.jar -d out JavaDump.java
//   java --add-opens java.base/java.lang=ALL-UNNAMED -Djava.awt.headless=true \
//        -cp "../plate-tectonics_ja.jar;out" JavaDump > java.json
import edu.colorado.phet.common.phetcommon.math.Bounds3F;
import edu.colorado.phet.common.phetcommon.model.clock.ClockAdapter;
import edu.colorado.phet.common.phetcommon.model.clock.ClockEvent;
import edu.colorado.phet.platetectonics.model.*;
import edu.colorado.phet.platetectonics.model.regions.*;
import edu.colorado.phet.platetectonics.util.Side;
import java.lang.reflect.Field;
import java.util.*;

public class JavaDump {
    static StringBuilder out = new StringBuilder();
    static Random mathRandom;

    static void seed(long s) { mathRandom.setSeed(s); }

    static String f(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        return Double.toString((float) d == d ? (double) (float) d : d);
    }

    static void dumpModel(PlateTectonicsModel m, String extra) {
        out.append("{");
        out.append(extra);
        out.append("\"regions\":[");
        boolean firstR = true;
        for (Region r : m.getRegions()) {
            if (!firstR) out.append(','); firstR = false;
            out.append("{\"type\":\"").append(r instanceof MagmaRegion ? "magma" : "region").append("\",\"b\":[");
            boolean firstB = true;
            for (Boundary b : r.getBoundaries()) {
                if (!firstB) out.append(','); firstB = false;
                out.append('[');
                boolean firstS = true;
                for (Sample s : b.samples) {
                    if (!firstS) out.append(','); firstS = false;
                    out.append('[').append(f(s.getPosition().x)).append(',').append(f(s.getPosition().y)).append(',')
                       .append(f(s.getPosition().z)).append(',').append(f(s.getTemperature())).append(',').append(f(s.getDensity())).append(']');
                }
                out.append(']');
            }
            out.append("]}");
        }
        out.append("],\"terrains\":[");
        boolean firstT = true;
        for (Terrain t : m.getTerrains()) {
            if (!firstT) out.append(','); firstT = false;
            out.append("{\"x\":[");
            for (int i = 0; i < t.xPositions.size(); i++) { if (i > 0) out.append(','); out.append(f(t.xPositions.get(i))); }
            out.append("],\"front\":[");
            int row = t.getFrontZIndex();
            for (int i = 0; i < t.getNumColumns(); i++) { if (i > 0) out.append(','); out.append(f(t.getSample(i, row).getElevation())); }
            out.append("]}");
        }
        out.append("],\"probe\":[");
        boolean firstP = true;
        Bounds3F bb = m.getBounds();
        for (int i = 0; i < 15; i++) for (int j = 0; j < 11; j++) {
            double x = bb.getMinX() + (bb.getMaxX() - bb.getMinX()) * (i + 0.5) / 15.0;
            double y = bb.getMinY() + (bb.getMaxY() - bb.getMinY()) * (j + 0.5) / 11.0;
            if (!firstP) out.append(','); firstP = false;
            out.append('[').append(f(m.getDensity(x, y))).append(',').append(f(m.getTemperature(x, y))).append(',')
               .append(f(m.getDensity(x + 3.7, y + 2.3))).append(',').append(f(m.getTemperature(x + 3.7, y + 2.3))).append(']');
        }
        out.append("]}");
    }

    static PlateType[] TYPES = { PlateType.CONTINENTAL, PlateType.YOUNG_OCEANIC, PlateType.OLD_OCEANIC };
    static String[] TYPE_NAMES = { "CONTINENTAL", "YOUNG_OCEANIC", "OLD_OCEANIC" };

    public static void main(String[] args) throws Exception {
        Math.random(); // force the holder's Random to exist, then grab it to reseed per scenario
        Class<?> holder = Class.forName("java.lang.Math$RandomNumberGeneratorHolder");
        Field fld = holder.getDeclaredField("randomNumberGenerator");
        fld.setAccessible(true);
        mathRandom = (Random) fld.get(null);

        out.append("{\"plate\":[");
        boolean firstScenario = true;
        long seedValue = 1000;
        for (int li = 0; li < 3; li++) for (int ri = 0; ri < 3; ri++) for (PlateMotionModel.MotionType mt : PlateMotionModel.MotionType.values()) {
            for (int ccw = 0; ccw < (mt == PlateMotionModel.MotionType.TRANSFORM ? 2 : 1); ccw++) {
                seedValue++;
                seed(seedValue);
                final TectonicsClock clock = new TectonicsClock(1.0);
                final PlateMotionModel model = new PlateMotionModel(clock, Bounds3F.fromMinMax(-700000f, 700000f, -300000f, 15000f, -1000000f, 0f));
                clock.addClockListener(new ClockAdapter() {
                    public void clockTicked(ClockEvent e) { model.update(e.getSimulationTimeChange()); }
                });
                model.dropCrust(Side.LEFT, TYPES[li]);
                model.dropCrust(Side.RIGHT, TYPES[ri]);
                boolean allowed = mt == PlateMotionModel.MotionType.CONVERGENT ? model.allowsConvergentMotion()
                        : mt == PlateMotionModel.MotionType.DIVERGENT ? model.allowsDivergentMotion() : model.allowsTransformMotion();
                if (!allowed) continue;
                if (ccw == 1) model.setTransformMotionCCW(false);
                model.motionType.set(mt);
                if (!firstScenario) out.append(','); firstScenario = false;
                out.append("{\"name\":\"").append(TYPE_NAMES[li]).append('/').append(TYPE_NAMES[ri]).append('/').append(mt.toString())
                   .append(ccw == 1 ? "/CW" : "").append("\",\"seed\":").append(seedValue).append(",\"frames\":[");
                clock.start();
                boolean firstFrame = true;
                for (int step = 0; step <= 600; step++) {
                    if (step % 50 == 0 || step == 600) {
                        if (!firstFrame) out.append(','); firstFrame = false;
                        dumpModel(model, "\"step\":" + step + ",\"time\":" + f(clock.getSimulationTime()) + ",\"limit\":" + f(clock.getTimeLimit())
                                + ",\"labels\":[" + model.rangeLabels.size() + ',' + model.boundaryLabels.size() + ',' + model.textLabels.size() + ',' + model.smokePuffs.size() + "],");
                    }
                    clock.stepByWallSeconds(0.1f);
                }
                out.append("]}");
            }
        }
        out.append("],\"crust\":[");
        double[][] settings = { {0.5, 0.5, 20000}, {0, 0, 20000}, {1, 1, 20000}, {0.5, 0.5, 70000}, {0.2, 0.9, 40000}, {0.9, 0.1, 5000} };
        for (int k = 0; k < settings.length; k++) {
            CrustModel cm = new CrustModel(Bounds3F.fromMinMax(-1500000f, 1500000f, -150000f, 15000f, -2000000f, 0f));
            cm.temperatureRatio.set(settings[k][0]);
            cm.compositionRatio.set(settings[k][1]);
            cm.thickness.set(settings[k][2]);
            if (k > 0) out.append(',');
            out.append("{\"name\":\"T").append(settings[k][0]).append("/C").append(settings[k][1]).append("/H").append(settings[k][2]).append("\",\"frames\":[");
            for (int step = 0; step <= 100; step++) {
                if (step % 20 == 0) {
                    if (step > 0) out.append(',');
                    dumpModel(cm, "\"step\":" + step + ",\"center\":" + f(cm.getCenterCrustElevation()) + ",");
                }
                cm.update(1.0 / 60.0);
            }
            out.append("]}");
        }
        out.append("]}");
        System.out.println(out);
        System.exit(0);
    }
}
