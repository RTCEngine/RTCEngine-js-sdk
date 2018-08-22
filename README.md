## RTCEngine js sdk 

[![Build Status](https://travis-ci.org/RTCEngine/RTCEngine-js-sdk.svg?branch=master)](https://travis-ci.org/RTCEngine/RTCEngine-js-sdk)




## Install and Run 


-  Set up the server


```

git clone https://github.com/RTCEngine/RTCEngine-server.git

cd RTCEngine-server && npm install 

DEBUG=* ts-node server.ts

```


- Set up js sdk 


```

git clone https://github.com/RTCEngine/RTCEngine-js-sdk.git

cd RTCEngine-js-sdk 

npm install && npm install --only=dev

gulp default

```


