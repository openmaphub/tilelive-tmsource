"use strict";

var fs = require("fs"),
    path = require("path"),
    url = require("url"),
    util = require("util");

var _ = require("underscore"),
    Bridge = require("tilelive-bridge"),
    carto = require("carto"),
    mapnik = require("mapnik"),
    mapnikref = require('mapnik-reference').load(mapnik.versions.mapnik),
    yaml = require("js-yaml");

var tm = {};

// Named projections.
tm.srs = {
  'WGS84': '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs',
  '900913': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over'
};
tm.extent = {
    'WGS84': [-180, -90, 180, 90],
    '900913': [-20037508.34, -20037508.34, 20037508.34, 20037508.34]
};

// Return an object with sorted keys, ignoring case.
tm.sortkeys = function(obj) {
  try {
    return obj.map(tm.sortkeys);
  } catch(e) {};
  try {
    return Object.keys(obj).sort(function(a, b) {
      a = a.toLowerCase();
      b = b.toLowerCase();
      if (a === 'id') return -1;
      if (b === 'id') return 1;
      if (a > b) return 1;
      if (a < b) return -1;
      return 0;
    }).reduce(function(memo, key) {
      memo[key] = tm.sortkeys(obj[key]);
      return memo;
    }, {});
  } catch(e) { return obj };
};

// Return an augmented uri object from url.parse with the pathname
// transformed into an unescaped dirname.
tm.parse = function(str) {
  var uri = url.parse(str);
  if (uri.pathname) uri.dirname = unescape(uri.pathname);
  return uri;
};

// Return true/false depending on whether a path is absolute.
tm.absolute = function(str) {
  if (str.charAt(0) === '/') return true;
  if ((/^[a-z]\:/i).test(str)) return true;
  return false;
};

var defaults = {
  name:'',
  description:'',
  attribution:'',
  mtime:+new Date,
  minzoom:0,
  maxzoom:6,
  center:[0,0,3],
  Layer:[],
  _prefs: {
    saveCenter: true,
    disabled: [],
    inspector: false
  }
};

var deflayer = {
  id:'',
  srs:'',
  description:'',
  fields: {},
  Datasource: {},
  properties: {
    minzoom:0,
    maxzoom:22,
    'buffer-size':0
  }
};

// Initialize defaults and derived properties on source data.
var normalize = function(data) {
  data = _(data).defaults(defaults);
  // Initialize deep defaults for _prefs, layers.
  data._prefs = _(data._prefs).defaults(defaults._prefs);
  data.Layer = data.Layer.map(function(l) {
    l = _(l).defaults(deflayer);
    // @TODO mapnikref doesn't distinguish between keys that belong in
    // layer properties vs. attributes...
    l.properties = _(l.properties).defaults(deflayer.properties);
    // Ensure datasource keys are valid.
    l.Datasource = _(l.Datasource).reduce(function(memo, val, key) {
      if (!mapnikref.datasources[l.Datasource.type]) return memo;
      if (key === 'type') memo[key] = val;
      if (key in mapnikref.datasources[l.Datasource.type]) memo[key] = val;
      // Set a default extent value for postgis based on the SRS.
      if (l.Datasource.type === 'postgis' && key === 'extent' && !val) {
        _(tm.srs).each(function(srs, id) {
            if (l.srs !== srs) return;
            memo[key] = tm.extent[id];
        });
      }
      return memo
    }, {});
    return l;
  });
  // Format property to distinguish from imagery tiles.
  data.format = 'pbf';
  // Construct vector_layers info from layer properties if necessary.
  data.vector_layers = data.Layer.map(function(l) {
    var info = {};
    info.id = l.id;
    if ('description' in l) info.description = l.description;
    if ('minzoom' in l.properties) info.minzoom = l.properties.minzoom;
    if ('maxzoom' in l.properties) info.maxzoom = l.properties.maxzoom;
    info.fields = [];
    var opts = _(l.Datasource).clone();

    if (opts.file && !tm.absolute(opts.file)) opts.base = tm.parse(data.id).dirname;
    try{
      var fields = new mapnik.Datasource(opts).describe().fields;
      info.fields = _(fields).reduce(function(memo, type, field) {
        memo[field] = l.fields[field] || type;
        return memo;
      }, {});
    }catch(err){
      
    }
    return info;
  });
  return data;
};


var toXML = function(data, callback) {
  // Include params to be written to XML.
  var opts = [
    "name",
    "description",
    "attribution",
    "bounds",
    "center",
    "format",
    "minzoom",
    "maxzoom"
  ].reduce(function(memo, key) {
    if (key in data) {
      memo[key] = data[key];
    }

    return memo;
  }, {});

  opts.srs = tm.srs['900913'];

  opts.Layer = data.Layer.map(function(l) {
    l.srs = l.srs || tm.srs["900913"];
    l.name = l.id;
    return l;
  });

  opts.json = JSON.stringify({
    vector_layers: data.vector_layers
  });

  try {
    return callback(null, new carto.Renderer().render(opts));
  } catch(err) {
    if (Array.isArray(err)) {
        err.forEach(function(e) {
            carto.writeError(e, options);
        });
    } else {
      return callback(err);
    }
  }
};


var TMSource = function(uri, callback) {
  uri = url.parse(uri);

  uri.pathname = path.resolve(uri.hostname + uri.pathname);
  uri.hostname = "";

  var self = this,
      filename = path.join(uri.hostname + uri.pathname, "data.yml");

  return fs.readFile(filename, "utf8", function(err, data) {
    if (err) {
      return callback(err);
    }

    try {
      self.info = yaml.load(data);
    } catch (err) {
      return callback(err);
    }

    self.info.id = url.format(uri);
    self.info = normalize(self.info);

    return toXML(self.info, function(err, xml) {
      if (err) {
        return callback(err);
      }

      uri.xml = xml;
      uri.base = uri.pathname;

      return Bridge.call(self, uri, callback);
    });
  });
};

TMSource.prototype.getInfo = function(callback) {
  return setImmediate(callback, this.info);
};

util.inherits(TMSource, Bridge);

TMSource.registerProtocols = function(tilelive) {
  tilelive.protocols["tmsource:"] = this;
};

module.exports = function(tilelive, options) {
  TMSource.registerProtocols(tilelive);

  return TMSource;
};
