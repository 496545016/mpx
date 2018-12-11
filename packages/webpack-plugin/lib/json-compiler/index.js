const async = require('async')
const path = require('path')
const hash = require('hash-sum')
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin')
const loaderUtils = require('loader-utils')
const parse = require('../parser')
const config = require('../config')
const stripJsonComments = require('strip-json-comments')
const RawSource = require('webpack-sources').RawSource

module.exports = function (raw) {
  // 该loader中会在每次编译中动态添加entry，不能缓存，否则watch不好使
  this.cacheable(false)
  const nativeCallback = this.async()

  if (!this._compilation.__mpx__) {
    return nativeCallback(null, raw)
  }

  const pagesMap = this._compilation.__mpx__.pagesMap
  const componentsMap = this._compilation.__mpx__.componentsMap
  const mode = this._compilation.__mpx__.mode
  const rootName = this._compilation._preparedEntrypoints[0].name
  const resourcePath = pagesMap[this.resource] || componentsMap[this.resource] || rootName
  const publicPath = this._compilation.outputOptions.publicPath || ''

  let entryDeps = new Set()

  let cacheCallback

  const checkEntryDeps = (callback) => {
    callback = callback || cacheCallback
    if (callback && entryDeps.size === 0) {
      callback()
    } else {
      cacheCallback = callback
    }
  }

  const addEntrySafely = (resource, name, callback) => {
    const dep = SingleEntryPlugin.createDependency(resource, name)
    entryDeps.add(dep)
    this._compilation.addEntry(this._compiler.context, dep, name, (err, module) => {
      entryDeps.delete(dep)
      checkEntryDeps()
      callback(err, module)
    })
  }

  // 初次处理json
  const callback = (err, processOutput) => {
    checkEntryDeps(() => {
      if (err) return nativeCallback(err)
      let output = `var json = ${JSON.stringify(json, null, 2)};\n`
      if (processOutput) output = processOutput(output)
      output += `module.exports = JSON.stringify(json, null, 2);\n`
      nativeCallback(null, output)
    })
  }

  let json
  try {
    json = JSON.parse(stripJsonComments(raw))
  } catch (err) {
    return callback(err)
  }

  function getName (raw) {
    const match = /^(.*?)(\.[^.]*)?$/.exec(raw)
    return match[1]
  }

  if (resourcePath === rootName) {
    // app.json

    const subPackagesMap = {}
    const localPages = []

    const processPackages = (packages, context, callback) => {
      if (packages) {
        async.forEach(json.packages, (packagePath, callback) => {
          let queryIndex = packagePath.indexOf('?')
          let packageQuery = '?'
          if (queryIndex >= 0) {
            packageQuery = packagePath.substr(queryIndex)
            packagePath = packagePath.substr(0, queryIndex)
          }
          let queryObj = loaderUtils.parseQuery(packageQuery)
          async.waterfall([
            (callback) => {
              this.resolve(context, packagePath, (err, result) => {
                callback(err, result)
              })
            },
            (result, callback) => {
              this._compiler.inputFileSystem.readFile(result, (err, content) => {
                callback(err, result, content.toString('utf-8'))
              })
            },
            (result, content, callback) => {
              const filePath = result
              const fileName = path.basename(filePath)
              const extName = path.extname(filePath)
              if (extName === '.mpx') {
                const parts = parse(
                  content,
                  fileName
                )
                if (parts.json) {
                  content = parts.json.content
                }
              }
              try {
                content = JSON.parse(content)
              } catch (err) {
                return callback(err)
              }
              if (content.pages) {
                let context = path.dirname(result)
                if (queryObj.root && typeof queryObj.root === 'string') {
                  let subPackages = [
                    {
                      tarRoot: queryObj.root,
                      pages: content.pages
                    }
                  ]
                  processSubPackages(subPackages, context, callback)
                } else {
                  processPages(content.pages, '', '', context, callback)
                }
              }
              // 目前只支持单层解析packages，为了兼容subPackages
            }
          ], callback)
        }, callback)
      } else {
        callback()
      }
    }

    const processSubPackages = (subPackages, context, callback) => {
      if (subPackages) {
        async.forEach(subPackages, (packageItem, callback) => {
          let tarRoot = packageItem.tarRoot || packageItem.root
          let srcRoot = packageItem.srcRoot || packageItem.root
          processPages(packageItem.pages, srcRoot, tarRoot, context, callback)
        }, callback)
      } else {
        callback()
      }
    }

    const processPages = (pages, srcRoot, tarRoot, context, callback) => {
      if (pages) {
        srcRoot = srcRoot || ''
        tarRoot = tarRoot || ''
        async.forEach(pages, (page, callback) => {
          let name = getName(path.posix.join(tarRoot, page))
          if (/^\./.test(name)) {
            return callback(new Error(`Page's path ${page} which is referenced in ${context} must be a subdirectory of ${context}!`))
          }
          async.waterfall([
            (callback) => {
              if (srcRoot) {
                callback(null, path.posix.join(context, srcRoot, page) + '.mpx')
              } else {
                this.resolve(context, page, (err, result) => {
                  callback(err, result)
                })
              }
            },
            (resource, callback) => {
              // 如果存在page命名冲突，return err
              for (let key in pagesMap) {
                if (pagesMap[key] === name && key !== resource) {
                  return callback(new Error(`Resources in ${resource} and ${key} are registered with same page path ${name}, which is not allowed!`))
                }
              }
              // 如果之前已经创建了入口，直接return
              if (pagesMap[resource] === name) return callback()
              pagesMap[resource] = name
              if (tarRoot) {
                if (!subPackagesMap[tarRoot]) {
                  subPackagesMap[tarRoot] = []
                }
                subPackagesMap[tarRoot].push(path.posix.join('', page))
              } else {
                localPages.push(name)
              }
              addEntrySafely(resource, name, callback)
            }
          ], callback)
        }, callback)
      } else {
        callback()
      }
    }

    const processTabBar = (output) => {
      let tabBarCfg = config[mode].tabBar
      let itemKey = tabBarCfg.itemKey
      let iconKey = tabBarCfg.iconKey
      let activeIconKey = tabBarCfg.activeIconKey
      if (json.tabBar && json.tabBar[itemKey]) {
        json.tabBar[itemKey].forEach((item, index) => {
          if (item.iconPath) {
            output += `json.tabBar.${itemKey}[${index}].${iconKey} = require("${item[iconKey]}");\n`
          }
          if (item.selectedIconPath) {
            output += `json.tabBar.${itemKey}[${index}].${activeIconKey} = require("${item[activeIconKey]}");\n`
          }
        })
      }
      return output
    }

    const processOptionMenu = (output) => {
      let optionMenuCfg = config[mode].optionMenu
      if (optionMenuCfg && json.optionMenu) {
        let iconKey = optionMenuCfg.iconKey
        output += `json.optionMenu.${iconKey} = require("${json.optionMenu[iconKey]}");\n`
      }
      return output
    }

    async.parallel([
      (callback) => {
        processPackages(json.packages, this.context, callback)
      },
      (callback) => {
        processSubPackages(json.subPackages, this.context, callback)
      },
      (callback) => {
        processPages(json.pages, '', '', this.context, callback)
      }
    ], (err) => {
      if (err) return callback(err)
      delete json.packages
      json.pages = localPages
      json.subPackages = []
      for (let root in subPackagesMap) {
        let subPackage = {
          root,
          pages: subPackagesMap[root]
        }
        json.subPackages.push(subPackage)
      }
      const processOutput = (output) => {
        output = processTabBar(output)
        output = processOptionMenu(output)
        return output
      }
      callback(null, processOutput)
    })
  } else {
    // page.json或component.json
    if (json.usingComponents) {
      const processNativeComponent = (sourceDir, outputDir, callback) => {
        let compilation = this._compilation
        let compiler = this._compiler

        const finder = (dir, callback) => {
          async.waterfall([
            (callback) => {
              compiler.inputFileSystem.readdir(dir, callback)
            },
            (files, callback) => {
              async.forEach(files, (val, callback) => {
                let fullPath = path.posix.join(dir, val)
                let stats = compiler.inputFileSystem.statSync(fullPath)
                if (stats.isDirectory()) {
                  finder(fullPath, callback)
                }
                if (stats.isFile()) {
                  let sourcePath = path.posix.relative(sourceDir, fullPath)
                  let assetsPath = path.posix.join(outputDir, sourcePath)
                  compiler.inputFileSystem.readFile(fullPath, (err, content) => {
                    if (err) {
                      callback(err)
                    } else {
                      compilation.assets[assetsPath] = new RawSource(content)
                      callback()
                    }
                  })
                }
              }, callback)
            },
            (callback) => {
              this.addContextDependency(sourceDir)
              callback()
            }
          ], callback)
        }

        finder(sourceDir, callback)
      }

      async.forEachOf(json.usingComponents, (component, name, callback) => {
        if (/^plugin:\/\//.test(component)) {
          return callback()
        }
        this.resolve(this.context, component, (err, result, resolveResult) => {
          if (err) return callback(err)
          let componentResource = resolveResult.path
          let componentQuery = resolveResult.query
          let parsed = path.parse(componentResource)
          let componentName = parsed.name
          let hashDirName = componentName + hash(result)
          let outputDir = path.posix.join('components', hashDirName)
          let componentPath = path.posix.join(outputDir, componentName)
          // 如果之前已经创建了入口，直接return
          if (componentsMap[result] === componentPath) return callback()
          componentsMap[result] = componentPath

          if (parsed.ext === '.js') {
            // 原生组件
            let sourceDir = parsed.dir
            let queryObj = componentQuery ? loaderUtils.parseQuery(componentQuery) : {}
            let fileName = componentName
            if (typeof queryObj.relativePath === 'string') {
              sourceDir = path.posix.resolve(componentResource, queryObj.relativePath)
              fileName = path.posix.relative(sourceDir, componentResource)
            }

            json.usingComponents[name] = path.posix.join(publicPath, outputDir, fileName)
            processNativeComponent(sourceDir, outputDir, callback)
          } else if (parsed.ext === '.mpx') {
            json.usingComponents[name] = publicPath + componentPath
            addEntrySafely(result, componentPath, callback)
          } else {
            callback(new Error(`package ${result} should have an entrance with .js or .mpx extension`))
          }
        })
      }, callback)
    } else {
      callback()
    }
  }
}
