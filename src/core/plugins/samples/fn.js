import { objectify, isFunc, normalizeArray, deeplyStripKey } from "core/utils"
import XML from "@kyleshockey/xml"
import memoizee from "memoizee"
import deepAssign from "@kyleshockey/object-assign-deep"

const primitives = {
  "string": () => "string",
  "string_email": () => "user@example.com",
  "string_date-time": () => new Date().toISOString(),
  "string_date": () => new Date().toISOString().substring(0, 10),
  "string_uuid": () => "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "string_hostname": () => "example.com",
  "string_ipv4": () => "198.51.100.42",
  "string_ipv6": () => "2001:0db8:5b96:0000:0000:426f:8e17:642a",
  "number": () => 0,
  "number_float": () => 0.0,
  "integer": () => 0,
  "boolean": (schema) => typeof schema.default === "boolean" ? schema.default : true
}

const primitive = (schema) => {
  schema = objectify(schema)
  let { type, format } = schema

  let fn = primitives[`${type}_${format}`] || primitives[type]

  if(isFunc(fn))
    return fn(schema)

  return "Unknown Type: " + schema.type
}

const extractDiscriminatorMappingValues = (discriminator) => {
  var discriminatorMappingValues
  if (discriminator && discriminator.propertyName && discriminator.mapping){
    discriminatorMappingValues ={}
    Object.keys(discriminator.mapping).map(function(key) {
      var mappingKey = discriminator.mapping[key]
      if(mappingKey){
        var mappingName = mappingKey.split("#")
        discriminatorMappingValues[mappingName[mappingName.length-1]] = key
      }
    })
  }
  return discriminatorMappingValues
}

const evaluateOptionName = (valueObj) => {
  if (valueObj.title){
    return valueObj.title 
  } else if (valueObj.$$ref){
    return valueObj.$$ref.split("/").pop(-1)
  } else if (valueObj.properties){
    let attr = Object.keys(valueObj.properties)
    return "Item " + (attr.length == 1 ? "(" + attr[0] + ")": attr.length > 1 ? "(" + attr[0] + ", ...)": "" )
  } else {
    return "Item" 
  }
}

const extractAlternativeSchema = (oneOfSchema, config, path, type, discriminator) => {
  if ( Array.isArray(oneOfSchema) && oneOfSchema.length > 0) {
    
    let { alternativeSchemas, alternativeSchemaSelections } = config

    let index = 0
    let options = {}
    let discriminatorMappingValues = extractDiscriminatorMappingValues(discriminator)

    oneOfSchema.map(valueObj => {
      options["#" + index++] = "#" + index + ": " + evaluateOptionName(valueObj) 
      
      if (discriminatorMappingValues && valueObj.properties && valueObj.$$ref){
        var discriminatorProperty = valueObj.properties[discriminator.propertyName]
        if (discriminatorProperty && !discriminatorProperty["example"]) {
          var mappingNane =  valueObj.$$ref.split("#")
          var example = discriminatorMappingValues[mappingNane[mappingNane.length-1]]
          if(example){
            discriminatorProperty["example"] = example
          }
        }
      }
      return true
    })

    let selectedIndex = alternativeSchemaSelections[path] || 0
    if ( selectedIndex >= oneOfSchema.length || selectedIndex < -1) {
      selectedIndex = 0
    }
    alternativeSchemas.push({ key: path, options: options, selectedIndex: selectedIndex, type})

    return selectedIndex >-1 ? oneOfSchema[selectedIndex] : undefined
  }
  return
}

export const sampleFromSchema = (schema, config={}, path="#") => {
  let { type, example, properties, additionalProperties, items, oneOf, anyOf, discriminator } = objectify(schema)
  let { includeReadOnly, includeWriteOnly, alternativeSchemas } = config

  if(example !== undefined) {
    return deeplyStripKey(example, "$$ref", (val) => {
      // do a couple of quick sanity tests to ensure the value
      // looks like a $$ref that swagger-client generates.
      return typeof val === "string" && val.indexOf("#") > -1
    })
  }

  if (alternativeSchemas && !items) {
    if (oneOf) {
      let oneOfSchema = extractAlternativeSchema(oneOf, config, path, "one of", discriminator)
      oneOfSchema = Object.assign({}, schema, oneOfSchema)
      if (schema.properties) {
        Object.assign(oneOfSchema.properties, schema.properties)
      } 
      delete oneOfSchema.oneOf
      return sampleFromSchema(oneOfSchema, config, path)
    }
    if (anyOf) {
      let anyOfSchema = extractAlternativeSchema(anyOf, config, path, "any of", discriminator)
      anyOfSchema = Object.assign({}, schema, anyOfSchema)
      if (schema.properties) {
        Object.assign(anyOfSchema.properties, schema.properties)
      } 
      delete anyOfSchema.anyOf
      return sampleFromSchema(anyOfSchema, config, path)
    }
  } 

  if (!type) {
    if (properties) {
      type = "object"
    } else if (items) {
      type = "array"
    } else {
      return
    }
  }

  if(type === "object") {
    let props = objectify(properties)

    let obj = {}
    for (var name in props) {
      if ( props[name] && props[name].deprecated ) {
        continue
      }
      if ( props[name] && props[name].readOnly && !includeReadOnly ) {
        continue
      }
      if ( props[name] && props[name].writeOnly && !includeWriteOnly ) {
        continue
      }
      obj[name] = sampleFromSchema(props[name], config, path + "/" + name)
    }

    if ( additionalProperties === true ) {
      obj.additionalProp1 = {}
    } else if ( additionalProperties ) {
      let additionalProps = objectify(additionalProperties)
      let additionalPropVal = sampleFromSchema(additionalProps, config)

      for (let i = 1; i < 4; i++) {
        obj["additionalProp" + i] = additionalPropVal
      }
    }
    return obj
  }

  if(type === "array") {
    if(Array.isArray(items.anyOf)) {
      return items.anyOf.map(i => sampleFromSchema(i, config, path + "[]"))
    }

    if(Array.isArray(items.oneOf) && !alternativeSchemas) {
      return items.oneOf.map(i => sampleFromSchema(i, config, path + "[]"))
    }

    return [ sampleFromSchema(items, config, path + "[]") ]
  }

  if(schema["enum"]) {
    if(schema["default"])
      return schema["default"]
    return normalizeArray(schema["enum"])[0]
  }

  if (type === "file") {
    return
  }

  return primitive(schema)
}

export const inferSchema = (thing) => {
  if(thing.schema)
    thing = thing.schema

  if(thing.properties) {
    thing.type = "object"
  }

  return thing // Hopefully this will have something schema like in it... `type` for example
}


export const sampleXmlFromSchema = (schema, config={}) => {
  let objectifySchema = deepAssign({}, objectify(schema))
  let { type, properties, additionalProperties, items, example } = objectifySchema
  let { includeReadOnly, includeWriteOnly } = config
  let defaultValue = objectifySchema.default
  let res = {}
  let _attr = {}
  let { xml } = schema
  let { name, prefix, namespace } = xml
  let enumValue = objectifySchema.enum
  let displayName, value

  if(!type) {
    if(properties || additionalProperties) {
      type = "object"
    } else if(items) {
      type = "array"
    } else {
      return
    }
  }

  name = name || "notagname"
  // add prefix to name if exists
  displayName = (prefix ? prefix + ":" : "") + name
  if ( namespace ) {
    //add prefix to namespace if exists
    let namespacePrefix = prefix ? ( "xmlns:" + prefix ) : "xmlns"
    _attr[namespacePrefix] = namespace
  }

  if (type === "array") {
    if (items) {
      items.xml = items.xml || xml || {}
      items.xml.name = items.xml.name || xml.name

      if (xml.wrapped) {
        res[displayName] = []
        if (Array.isArray(example)) {
          example.forEach((v)=>{
            items.example = v
            res[displayName].push(sampleXmlFromSchema(items, config))
          })
        } else if (Array.isArray(defaultValue)) {
          defaultValue.forEach((v)=>{
            items.default = v
            res[displayName].push(sampleXmlFromSchema(items, config))
          })
        } else {
          res[displayName] = [sampleXmlFromSchema(items, config)]
        }

        if (_attr) {
          res[displayName].push({_attr: _attr})
        }
        return res
      }

      let _res = []

      if (Array.isArray(example)) {
        example.forEach((v)=>{
          items.example = v
          _res.push(sampleXmlFromSchema(items, config))
        })
        return _res
      } else if (Array.isArray(defaultValue)) {
        defaultValue.forEach((v)=>{
          items.default = v
          _res.push(sampleXmlFromSchema(items, config))
        })
        return _res
      }

      return sampleXmlFromSchema(items, config)
    }
  }

  if (type === "object") {
    let props = objectify(properties)
    res[displayName] = []
    example = example || {}

    for (let propName in props) {
      if (!props.hasOwnProperty(propName)) {
        continue
      }
      if ( props[propName].readOnly && !includeReadOnly ) {
        continue
      }
      if ( props[propName].writeOnly && !includeWriteOnly ) {
        continue
      }

      props[propName].xml = props[propName].xml || {}

      if (props[propName].xml.attribute) {
        let enumAttrVal = Array.isArray(props[propName].enum) && props[propName].enum[0]
        let attrExample = props[propName].example
        let attrDefault = props[propName].default
        _attr[props[propName].xml.name || propName] = attrExample!== undefined && attrExample
          || example[propName] !== undefined && example[propName] || attrDefault !== undefined && attrDefault
          || enumAttrVal || primitive(props[propName])
      } else {
        props[propName].xml.name = props[propName].xml.name || propName
        if(props[propName].example === undefined && example[propName] !== undefined) {
          props[propName].example = example[propName]
        }
        let t = sampleXmlFromSchema(props[propName])
        if (Array.isArray(t)) {
          res[displayName] = res[displayName].concat(t)
        } else {
          res[displayName].push(t)
        }

      }
    }

    if (additionalProperties === true) {
      res[displayName].push({additionalProp: "Anything can be here"})
    } else if (additionalProperties) {
      res[displayName].push({additionalProp: primitive(additionalProperties)})
    }

    if (_attr) {
      res[displayName].push({_attr: _attr})
    }
    return res
  }

  if (example !== undefined) {
    value = example
  } else if (defaultValue !== undefined) {
    //display example if exists
    value = defaultValue
  } else if (Array.isArray(enumValue)) {
    //display enum first value
    value = enumValue[0]
  } else {
    //set default value
    value = primitive(schema)
  }

  res[displayName] = _attr ? [{_attr: _attr}, value] : value

  return res
}

export function createXMLExample(schema, config) {
  let json = sampleXmlFromSchema(schema, config)
  if (!json) { return }

  return XML(json, { declaration: true, indent: "\t" })
}

export const memoizedCreateXMLExample = memoizee(createXMLExample)

export const memoizedSampleFromSchema = memoizee(sampleFromSchema)
