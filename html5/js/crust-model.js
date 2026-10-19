// Crust tab model (port of edu.colorado.phet.platetectonics.model.CrustModel)
(function () {
  'use strict';
  const PT = window.PT;
  const { V2, V3, Side, Property, Terrain, TerrainSample, TerrainConnectorStrip, Sample, CrossSectionStrip,
    TextureStrategy, PlateTectonicsModel, ZERO_CELSIUS, linear } = PT;

  const computeCrustElevation = (thickness, density) => thickness * (1 - density / 3300) - 3500;
  const LEFT_OCEANIC_ELEVATION = computeCrustElevation(7000, 3000);
  const RIGHT_CONTINENTAL_ELEVATION = computeCrustElevation(45000, 2700);
  const MAX_FLAT_X = PlateTectonicsModel.MAX_FLAT_X;

  // depth (km) / density pairs
  const mantleDepthDensity = [0, 1020, 3, 2600, 15, 2900, 25, 3381, 71, 3376, 171, 3364, 220, 3436, 271, 3466, 371, 3526,
    400, 3723, 471, 3813, 571, 3939, 670, 4381, 771, 4443, 871, 4503, 971, 4563, 1071, 4621, 1171, 4678, 1271, 4734,
    1371, 4789, 1471, 4844, 1571, 4897, 1671, 4950, 1771, 5003, 1871, 5054, 1971, 5106, 2071, 5157, 2171, 5207, 2271,
    5257, 2371, 5307, 2471, 5357, 2571, 5407, 2671, 5457, 2771, 5506, 2871, 5556, 2891, 5566];
  const OUTER_CORE_DENSITY = linear(-5180000, -2921000, 12800, 10000);
  const INNER_CORE_DENSITY = linear(-6371000, -5180000, 13100, 12800);

  function getMantleDensity(y) {
    const depth = -y;
    for (let i = 0; i < mantleDepthDensity.length; i += 2) {
      if (!(depth < mantleDepthDensity[i] * 1000)) continue;
      const d0 = mantleDepthDensity[i - 2] * 1000, d1 = mantleDepthDensity[i] * 1000;
      const v0 = mantleDepthDensity[i - 1], v1 = mantleDepthDensity[i + 1];
      return v0 + ((depth - d0) / (d1 - d0)) * (v1 - v0);
    }
    return mantleDepthDensity[mantleDepthDensity.length - 1];
  }
  const getCoreDensity = (y) => (y > -5180000 ? OUTER_CORE_DENSITY(y) : INNER_CORE_DENSITY(y));
  const getMantleOrCoreDensity = (y) => (y > -2921000 ? getMantleDensity(y) : getCoreDensity(y));

  class CrustModel extends PlateTectonicsModel {
    constructor(bounds) {
      super(bounds, new TextureStrategy(2e-5));
      this.temperatureRatio = new Property(0.5);
      this.compositionRatio = new Property(0.5);
      this.thickness = new Property(20000);
      this.terrainConnectors = [];
      this.crustElevation = this.computeIdealCrustElevation();
      this.crustVelocity = 0;
      const ts = this.getTextureStrategy();
      const zs = 20;

      const makeTerrain = (xs, elevationFn, side) => {
        const t = new Terrain(zs, bounds.minZ, bounds.maxZ);
        for (const x of xs) {
          const col = [];
          for (let i = 0; i < zs; i++) {
            const z = bounds.minZ + (i / 19) * (bounds.maxZ - bounds.minZ);
            col.push(new TerrainSample(elevationFn(), ts.mapTop(new V2(x, z))));
          }
          t.addColumn(side, x, col);
        }
        return t;
      };
      const oceanicXs = [], middleXs = [], continentalXs = [];
      for (let i = 49; i >= 0; i--) oceanicXs.push(-MAX_FLAT_X + Math.pow(i / 49, 0.3) * (-75000 + MAX_FLAT_X));
      for (let i = 0; i < 50; i++) middleXs.push(-75000 + (i / 49) * 150000);
      for (let i = 0; i < 50; i++) continentalXs.push(75000 + (1 - Math.pow(1 - i / 49, 0.3)) * (MAX_FLAT_X - 75000));
      this.oceanicTerrain = makeTerrain(oceanicXs, () => LEFT_OCEANIC_ELEVATION, Side.LEFT);
      this.middleTerrain = makeTerrain(middleXs, () => this.getCenterCrustElevation(), Side.RIGHT);
      this.continentalTerrain = makeTerrain(continentalXs, () => RIGHT_CONTINENTAL_ELEVATION, Side.RIGHT);
      this.addTerrain(this.oceanicTerrain);
      this.addTerrain(this.middleTerrain);
      this.addTerrain(this.continentalTerrain);
      for (const [a, b] of [[this.oceanicTerrain, this.middleTerrain], [this.middleTerrain, this.continentalTerrain]]) {
        const c = new TerrainConnectorStrip(a, b, 10, bounds.minZ, bounds.maxZ);
        this.terrainConnectors.push(c);
        this.addTerrain(c);
      }

      const minY = bounds.minY;
      const toMinY = (v) => new V2(v.x, minY);
      const oceanTop = this.oceanicTerrain.getFrontVertices();
      const oceanCrustBottom = oceanTop.map((v) => new V2(v.x, v.y - 7000));
      const oceanMinY = oceanTop.map(toMinY);
      const contTop = this.continentalTerrain.getFrontVertices();
      const contCrustBottom = contTop.map((v) => new V2(v.x, v.y - 45000));
      const contMinY = contTop.map(toMinY);
      const middleTop = this.middleTerrain.getFrontVertices();
      const middleBottom = new Array(middleTop.length);
      const middleMinY = middleTop.map(toMinY);
      const crustTopSamples = [], crustBottomSamples = [], mantleTopSamples = [], mantleBottomSamples = [];

      // center crust temperature as function of elevation
      const centerTemp = (y) => {
        const r = -((y - this.getCenterCrustElevation()) / this.thickness.get());
        return ZERO_CELSIUS + r * 700 * this.temperatureRatio.get();
      };
      for (let i = 0; i < middleTop.length; i++) {
        crustTopSamples.push(new Sample(new V3(), 0, this.getCenterCrustDensity(), new V2()));
        crustBottomSamples.push(new Sample(new V3(), 0, this.getCenterCrustDensity(), new V2()));
        mantleTopSamples.push(new Sample(new V3(), ZERO_CELSIUS + 700, 3300, new V2()));
        mantleBottomSamples.push(new Sample(new V3(middleMinY[i].x, middleMinY[i].y, 0), ZERO_CELSIUS + 700, 3300, ts.mapFront(middleMinY[i])));
      }
      this.middleUpdate = () => {
        const top = this.middleTerrain.getFrontVertices();
        const density = this.getCenterCrustDensity();
        for (let n = 0; n < top.length; n++) {
          middleTop[n] = top[n];
          middleBottom[n] = new V2(top[n].x, top[n].y - this.thickness.get());
          const p = new V3(top[n].x, top[n].y, 0), q = new V3(middleBottom[n].x, middleBottom[n].y, 0);
          crustTopSamples[n].position = p;
          crustBottomSamples[n].position = q;
          crustTopSamples[n].textureCoordinates = ts.mapFront(new V2(top[n].x, 0));
          crustBottomSamples[n].textureCoordinates = ts.mapFront(new V2(top[n].x, -this.thickness.get()));
          mantleTopSamples[n].position = q;
          mantleTopSamples[n].textureCoordinates = ts.mapFront(middleBottom[n]);
          crustTopSamples[n].temperature = centerTemp(top[n].y);
          crustBottomSamples[n].temperature = centerTemp(middleBottom[n].y);
          crustTopSamples[n].density = density;
          crustBottomSamples[n].density = density;
        }
      };
      this.temperatureRatio.addObserver(this.middleUpdate, false);
      this.compositionRatio.addObserver(this.middleUpdate, false);
      this.middleUpdate();

      // full-width front vertex list along the bottom of the lithosphere box
      const combined = oceanMinY.slice(0, oceanMinY.length - 1)
        .concat(middleMinY.slice(0, middleMinY.length - 1))
        .concat(contMinY);
      // Java copies with overlapping indices; equivalent to dropping the duplicated junction points
      const atY = (arr, y) => arr.map((v) => new V2(v.x, y));
      const v750 = atY(combined, -750000), v2921 = atY(combined, -2921000), v5180 = atY(combined, -5180000), v6371 = atY(combined, -6371000);

      // left oceanic crust
      let s = new CrossSectionStrip();
      for (let n = 0; n < oceanTop.length; n++) {
        s.addPatch(Side.RIGHT,
          new Sample(new V3(oceanTop[n].x, oceanTop[n].y, 0), centerTemp(oceanTop[n].y), 3000, ts.mapFront(oceanTop[n])),
          new Sample(new V3(oceanCrustBottom[n].x, oceanCrustBottom[n].y, 0), centerTemp(oceanCrustBottom[n].y), 3000, ts.mapFront(oceanCrustBottom[n])));
      }
      this.addStrip(s);
      // right continental crust
      const contTemp = (y) => ZERO_CELSIUS + -((y - RIGHT_CONTINENTAL_ELEVATION) / 45000) * 450;
      s = new CrossSectionStrip();
      for (let n = 0; n < contTop.length; n++) {
        s.addPatch(Side.RIGHT,
          new Sample(new V3(contTop[n].x, contTop[n].y, 0), contTemp(contTop[n].y), 2700, ts.mapFront(contTop[n])),
          new Sample(new V3(contCrustBottom[n].x, contCrustBottom[n].y, 0), contTemp(contCrustBottom[n].y), 2700, ts.mapFront(contCrustBottom[n])));
      }
      this.addStrip(s);
      this.middleCrustStrip = new CrossSectionStrip(crustTopSamples, crustBottomSamples);
      this.addStrip(this.middleCrustStrip);
      this.middleMantleStrip = new CrossSectionStrip(mantleTopSamples, mantleBottomSamples);
      this.addStrip(this.middleMantleStrip);
      const T = ZERO_CELSIUS;
      this.addStrip(this.rect(oceanCrustBottom, oceanMinY, 3300, 3300, T + 700, T + 700));
      this.addStrip(this.rect(contCrustBottom, contMinY, 3300, 3300, T + 700, T + 700));
      this.addStrip(this.rect(combined, v750, getMantleDensity(minY), getMantleDensity(-750000), T + 700, T + 1100));
      this.addStrip(this.rect(v750, v2921, getMantleDensity(-750000), getMantleDensity(-2921000), T + 1100, T + 4000));
      this.addStrip(this.rect(v2921, v5180, 10000, 12800, T + 4400, 5778));
      this.addStrip(this.rect(v5180, v6371, 12800, 13100, 5778, 5778));
      this.updateView();
    }

    rect(tops, bottoms, d1, d2, t1, t2) {
      const ts = this.getTextureStrategy();
      const s = new CrossSectionStrip();
      for (let i = 0; i < tops.length; i++) {
        s.addPatch(Side.RIGHT,
          new Sample(new V3(tops[i].x, tops[i].y, 0), t1, d1, ts.mapFront(tops[i])),
          new Sample(new V3(bottoms[i].x, bottoms[i].y, 0), t2, d2, ts.mapFront(bottoms[i])));
      }
      return s;
    }

    resetAll() {
      this.thickness.reset();
      this.temperatureRatio.reset();
      this.compositionRatio.reset();
      this.crustElevation = this.computeIdealCrustElevation();
      this.crustVelocity = 0;
    }

    // damped spring toward the isostatic equilibrium elevation
    update(dt) {
      dt *= 100;
      const delta = this.computeIdealCrustElevation() - this.crustElevation;
      const k = 0.01;
      this.crustElevation += this.crustVelocity * dt;
      this.crustVelocity += delta * k * dt;
      this.crustVelocity /= Math.exp(dt / 9);
      this.updateView();
    }

    updateView() {
      this.middleTerrain.setToFlatElevation(this.getCenterCrustElevation());
      this.middleTerrain.elevationChanged.emit(this.middleTerrain);
      for (const c of this.terrainConnectors) c.update();
      this.middleUpdate();
      this.middleCrustStrip.update();
      this.middleMantleStrip.update();
      this.modelChanged.emit();
    }

    getCenterCrustDensity() {
      const d = 0.8 * (1 - this.compositionRatio.get()) + 0.1 * (1 - this.temperatureRatio.get());
      return 2600 + 700 * d;
    }
    getCenterCrustElevation() { return this.crustElevation; }
    computeIdealCrustElevation() { return computeCrustElevation(this.thickness.get(), this.getCenterCrustDensity()); }
    getCenterCrustBottomY() { return this.getCenterCrustElevation() - this.thickness.get(); }

    getDensity(x, y) {
      if (x < -75000) {
        if (y > 0) return PlateTectonicsModel.getAirDensity(y);
        if (y > LEFT_OCEANIC_ELEVATION) return PlateTectonicsModel.getWaterDensity(y);
        if (y > LEFT_OCEANIC_ELEVATION - 7000) return 3000;
        return getMantleOrCoreDensity(y);
      }
      if (x > 75000) {
        if (y > RIGHT_CONTINENTAL_ELEVATION) return PlateTectonicsModel.getAirDensity(y);
        if (y > RIGHT_CONTINENTAL_ELEVATION - 45000) return 2700;
        return getMantleOrCoreDensity(y);
      }
      if (y > this.getCenterCrustElevation()) {
        return y > 0 ? PlateTectonicsModel.getAirDensity(y) : PlateTectonicsModel.getWaterDensity(y);
      }
      if (y > this.getCenterCrustBottomY()) return this.getCenterCrustDensity();
      return getMantleOrCoreDensity(y);
    }

    getTemperature(x, y) {
      const hit = this.firstStripIntersection(x, y);
      if (hit) return hit.temperature;
      return y < 0 ? PlateTectonicsModel.getWaterTemperature(y) : PlateTectonicsModel.getAirTemperature(y);
    }
  }
  CrustModel.getMantleDensity = getMantleDensity;
  CrustModel.getMantleOrCoreDensity = getMantleOrCoreDensity;

  PT.CrustModel = CrustModel;
})();
