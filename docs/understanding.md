# mpx运行机制

下面我们分别从运行时和编译两个方面介绍mpx的实现机制

## 数据响应与性能优化
数据响应作为Vue最核心的特性，在我们的日常开发中被大量使用，能够极大地提高前端开发体验和效率，我们在框架设计初期最早考虑的就是如何将数据响应特性加入到小程序开发中。在数据响应的实现上，我们引入了MobX，一个实现了纯粹数据响应能力的知名开源项目。借助MobX和mixins，我们在小程序组件创建初期建立了一个响应式数据管理系统，该系统观察着小程序组件中的所有数据(data/props/computed)并基于数据的变更驱动视图的渲染(setData)及用户注册的watch回调，实现了Vue中的数据响应编程体验。与此同时，我们基于MobX封装实现了一个Vuex规范的数据管理store，能够方便地注入组件进行全局数据管理。为了提高跨团队开发的体验，我们对store添加了多实例可合并的特性，不同团队维护自己的store，在需要时能够合并他人或者公共的store生成新的store实例，我们认为这是一种比Vuex中modules更加灵活便捷的跨团队数据管理模式

作为一个接管了小程序setData的数据响应开发框架，我们高度重视Mpx的渲染性能，通过小程序官方文档中提到的性能优化建议可以得知，setData对于小程序性能来说是重中之重，setData优化的方向主要有两个：
1. 尽可能减少setData调用的频次
2. 尽可能减少单次setData传输的数据

为了实现以上两个优化方向，我们做了以下几项工作：
* 将组件的静态模板编译为可执行的render函数，通过render函数收集模板数据依赖，只有当render函数中的依赖数据发生变化时才会触发小程序组件的setData，同时通过一个异步队列确保一个tick中最多只会进行一次setData，这个机制和Vue中的render机制非常类似，大大降低了setData的调用频次；
* 将模板编译render函数的过程中，我们还记录输出了模板中使用的数据路径，在每次需要setData时会根据这些数据路径与上一次的数据进行diff，仅将发生变化的数据通过数据路径的方式进行setData，这样确保了每次setData传输的数据量最低，同时避免了不必要的setData操作，进一步降低了setData的频次。

![Mpx数据响应机制流程示意图](https://dpubstatic.udache.com/static/dpubimg/4cb54489-b99d-4560-97aa-68f756730131.jpeg)

*Mpx数据响应机制流程示意图*

## 编译构建
我们希望使用目前设计最强大、生态最完善的编译构建工具Webpack来实现小程序的编译构建，让用户得到web开发中先进强大的工程化开发体验。使用过Webpack的同学都知道，通常来说Webpack都是将项目中使用到的一系列碎片化模块打包为一个或几个bundle，而小程序所需要的文件结构是非常离散化的，如何调解这两者的矛盾成为了我们最大的难题。一种非常直观简单的思路在于遍历整个src目录，将其中的每一个.mpx文件都作为一个entry加入到Webpack中进行处理，这样做的问题主要有两个：
1. src目录中用不到的的.mpx文件也会被编译输出，最终也会被小程序打包进项目包中，无意义地增加了包体积；
2. 对于node_modules下的.mpx文件，我们不认为遍历node_modules是一个好的选择。

最终我们采用了一种基于依赖分析和动态添加entry的方式来进行实现，用户在Webpack配置中只需要配置一个入口文件app.mpx，loader在解析到json时会解析json中pages域和usingComponents域中声明的路径，通过动态添加entry的方式将这些文件添加到Webpack的构建系统当中（注意这里是添加entry而不是添加依赖，因为只有entry能生成独立的文件，满足小程序的离散化文件结构），并递归执行这个过程，直到整个项目中所有用到的.mpx文件都加入进来，在输出前，我们借助了CommonsChunkPlugin/SplitChunksPlugin的能力将复用的模块抽取到一个外部的bundle中，确保最终生成的包中不包含重复模块。我们提供了一个Webpack插件和一个.mpx文件对应的loader来实现上述操作，用户只需要将其添加到Webpack配置中就可以以打包web项目的方式正常打包小程序，没有任何的前置和后置操作，支持Webpack本身的完整生态。
 
![Mpx编译构建机制流程示意图](https://dpubstatic.udache.com/static/dpubimg/ce6d470c-0a4c-486e-a2f5-ad225c289832.jpeg)

*Mpx编译构建机制流程示意图*

## 图像资源处理

> 本文介绍小程序既有的对图像资源的支持

> mpx提供了@mpxjs/url-loader将本地图像资源进行打包

在小程序中，你可能有这些使用图像资源的方式：
* `.wxss`使用图像，例如`background-image`属性
* 小程序`<image>`标签

不同的引用资源的方式，受限于小程序的基础能力，在mpx中提供了不同的解决方案。

### 引用线上资源

小程序支持在`wxss`和`wxml`中使用线上资源

```css
.container: {
  background-image: url('http://my.cdn.com/bg1.png');
}
```

```html
<view>
  <image src='http://my.cdn.com/bg2.png'/>
  <view class="container"></view>
<view>

```

### 引用本地资源

小程序目前支持的引用图像资源的方式
* `.wxss`中**无法**通过路径访问本地图像，需要打包成base64

```css
.container: {
  background-image: url("data:image/png;base64,iVBORw0KGgo=..."); // 正确
}

.another-container: {
  background-image: url("/page/index/index.png"); // 错误
}

```
 
* `<image>`标签在src属性中设置图像路径

```html
<view>
  <image src='/img/myImg.png'/>
<view>

```

* `<image>`标签在src属性中使用base64

```html
<view>
  <image src="data:image/png;base64,iVBORw0KGgo=..."/>
<view>

```

* 内联style通过base64使用图像设置样式

```html
<view>
  <view style="background-image: url("data:image/png;base64,iVBORw0KGgo=...")"></view>
<view>
```